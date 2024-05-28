// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import * as THREE from "three";

import { toNanoSec } from "@foxglove/rostime";
import { SettingsTreeAction, SettingsTreeFields } from "@foxglove/studio";
import type { RosValue } from "@foxglove/studio-base/players/types";

// import { Axis, AXIS_LENGTH } from "./AxisOrg";//为了区分自定义的Axis  yxd 20230607
// import { Axis, AXIS_LENGTH } from "./Axis";//为了区分自定义的Axis  yxd 20230607
import { AxisMark, AXIS_LENGTH, MARK_TYPE } from "./AxisMark";

import { RenderableArrow } from "./markers/RenderableArrow";
import { RenderableLineStrip } from "./markers/RenderableLineStrip";
import type { IRenderer } from "../IRenderer";
import { BaseUserData, Renderable } from "../Renderable";
import { PartialMessage, PartialMessageEvent, SceneExtension } from "../SceneExtension";
import { SettingsTreeEntry } from "../SettingsManager";
import { rgbaToCssString } from "../color";
import { vecEqual } from "../math";
import { normalizeHeader, normalizePose } from "../normalizeMessages";
import {
  PoseArray,
  ColorRGBA,
  NAV_PATH_DATATYPES,
  NavPath,
} from "../ros";
import {
  BaseSettings,
  fieldGradient,
  fieldSize,
  PRECISION_DISTANCE,
} from "../settings";
import { topicIsConvertibleToSchema } from "../topicIsConvertibleToSchema";
import { makePose, Pose } from "../transforms";
import { Label } from "@foxglove/three-text";

type GradientRgba = [ColorRGBA, ColorRGBA];
type Gradient = [string, string];
type DisplayType = "axis" | "arrow" | "line";

export type LayerSettingsPoseArray = BaseSettings & {
  type: DisplayType;
  axisScale: number;
  arrowScale: [number, number, number];
  lineWidth: number;
  gradient: Gradient;
};
//设置选项
export type LayerSettingsPoseArrayWayPoint = BaseSettings & {
  axisScale: number;
  gradient: Gradient;
};

const DEFAULT_TYPE: DisplayType = "axis";
const DEFAULT_AXIS_SCALE = AXIS_LENGTH;
const DEFAULT_ARROW_SCALE: THREE.Vector3Tuple = [1, 0.15, 0.15];
const DEFAULT_LINE_WIDTH = 0.2;
const DEFAULT_GRADIENT: GradientRgba = [
  { r: 124 / 255, g: 107 / 255, b: 1, a: 1 },
  { r: 124 / 255, g: 107 / 255, b: 1, a: 0.5 },
];

const MISMATCHED_FRAME_ID = "MISMATCHED_FRAME_ID";

const DEFAULT_GRADIENT_STR: Gradient = [
  rgbaToCssString(DEFAULT_GRADIENT[0]!),
  rgbaToCssString(DEFAULT_GRADIENT[1]!),
];

const DEFAULT_SETTINGS: LayerSettingsPoseArray = {
  visible: false,
  type: DEFAULT_TYPE,
  axisScale: DEFAULT_AXIS_SCALE,
  arrowScale: DEFAULT_ARROW_SCALE,
  lineWidth: DEFAULT_LINE_WIDTH,
  gradient: DEFAULT_GRADIENT_STR,
};
//设置选项的默认值 maybe use
// const DEFAULT_SETTINGS1: LayerSettingsPoseArrayWayPoint = {
//   visible: false,
//   axisScale: DEFAULT_AXIS_SCALE,
//   gradient: DEFAULT_GRADIENT_STR,
// };

export type PoseArrayUserData = BaseUserData & {
  settings: LayerSettingsPoseArray;
  topic: string;
  poseArrayMessage: PoseArray;
  originalMessage: Record<string, RosValue>;
  // axes: Axis[];
  axes: AxisMark[];
  arrows: RenderableArrow[];
  lineStrip?: RenderableLineStrip;
  label:Label[];
};

export class PoseArrayRenderable extends Renderable<PoseArrayUserData> {
  public override dispose(): void {
    this.userData.axes.forEach((axis) => axis.dispose());
    this.userData.arrows.forEach((arrow) => arrow.dispose());
    this.userData.lineStrip?.dispose();
    super.dispose();
  }

  public override details(): Record<string, RosValue> {
    return this.userData.originalMessage;
  }

  public removeArrows(): void {
    for (const arrow of this.userData.arrows) {
      this.remove(arrow);
      arrow.dispose();
    }
    this.userData.arrows.length = 0;
  }

  public removeAxes(): void {
    for (const axis of this.userData.axes) {
      this.remove(axis);
      axis.dispose();
    }
    this.userData.axes.length = 0;
  }

  public removeLineStrip(): void {
    if (this.userData.lineStrip) {
      this.remove(this.userData.lineStrip);
      this.userData.lineStrip.dispose();
      this.userData.lineStrip = undefined;
    }
  }
}

export class PoseArraysWayPoint extends SceneExtension<PoseArrayRenderable> {
  public constructor(renderer: IRenderer) {
    super("foxglove.PoseArrays", renderer);
    //添加主题订阅，当有相关数据来的时候会触发执行
    renderer.addSchemaSubscriptions(NAV_PATH_DATATYPES, this.handleNavPath);
  }
  //在设置面板上添加这个Path Topic的设置节点，不影响3D面板上数据的显示  yxd 20230521
  public override settingsNodes(): SettingsTreeEntry[] {    
    const configTopics = this.renderer.config.topics;
    const handler = this.handleSettingsAction;
    const entries: SettingsTreeEntry[] = [];
    // 通过对topics循环遍历，如果有对应的topic就添加相应的设置
    for (const topic of this.renderer.topics ?? []) {
      if (
        !(
          topicIsConvertibleToSchema(topic, NAV_PATH_DATATYPES) 
        )
      ) {
        continue;
      }
      const config = (configTopics[topic.name] ?? {}) as Partial<LayerSettingsPoseArray>;
    
      const { axisScale } = config;
      const gradient = config.gradient ?? DEFAULT_GRADIENT_STR;

      const fields: SettingsTreeFields = {};
      fields["axisScale"] = fieldSize("Scale", axisScale, PRECISION_DISTANCE);
      fields["gradient"] = fieldGradient("Gradient", gradient);

      entries.push({
        path: ["topics", topic.name],
        node: {
          label: topic.name,
          icon: topicIsConvertibleToSchema(topic, NAV_PATH_DATATYPES) ? "Timeline" : "Flag",
          fields,
          visible: config.visible ?? DEFAULT_SETTINGS.visible,
          handler,
        },
      });
    }
    return entries;
  }
  //当设置面板上做了改变后触发该事件
  public override handleSettingsAction = (action: SettingsTreeAction): void => {
    const path = action.payload.path;
    if (action.action !== "update" || path.length !== 3) {
      return;
    }
    this.saveSetting(path, action.payload.value);

    // Update the renderable
    const topicName = path[1]!;
    const renderable = this.renderables.get(topicName);
    if (renderable) {
      const settings = this.renderer.config.topics[topicName] as
        | Partial<LayerSettingsPoseArray>
        | undefined;
      const defaultType = { type: getDefaultType() };
      this._updatePoseArrayRenderable(
        renderable,
        renderable.userData.poseArrayMessage,
        renderable.userData.originalMessage,
        renderable.userData.receiveTime,
        { ...DEFAULT_SETTINGS, ...defaultType, ...settings },
      );
    }
  };
  //nav_msgs/Path或robot_interfaces/Path这种主题数据接收到时触发
  private handleNavPath = (messageEvent: PartialMessageEvent<NavPath>): void => {
    if (!validateNavPath(messageEvent, this.renderer)) {
      return;
    }

    const poseArrayMessage = normalizeNavPathToPoseArray(messageEvent.message);
    const receiveTime = toNanoSec(messageEvent.receiveTime);
    this.addPoseArray(messageEvent.topic, poseArrayMessage, messageEvent.message, receiveTime);
  };
  private addPoseArray(
    topic: string,
    poseArrayMessage: PoseArray,
    originalMessage: Record<string, RosValue>,
    receiveTime: bigint,
  ): void {
    let renderable = this.renderables.get(topic);

    if (!renderable) {
      // Set the initial settings from default values merged with any user settings
      const userSettings = this.renderer.config.topics[topic] as
        | Partial<LayerSettingsPoseArray>
        | undefined;
      const defaultType = { type: getDefaultType() };
      const settings = { ...DEFAULT_SETTINGS, ...defaultType, ...userSettings };

      renderable = new PoseArrayRenderable(topic, this.renderer, {
        receiveTime,
        messageTime: toNanoSec(poseArrayMessage.header.stamp),
        frameId: this.renderer.normalizeFrameId(poseArrayMessage.header.frame_id),
        pose: makePose(),
        settingsPath: ["topics", topic],
        settings,
        topic,
        poseArrayMessage,
        originalMessage,
        axes: [],
        arrows: [],
        label:[],
      });

      this.add(renderable);
      this.renderables.set(topic, renderable);
    }

    this._updatePoseArrayRenderable(
      renderable,
      poseArrayMessage,
      originalMessage,
      receiveTime,
      renderable.userData.settings,
    );
  }

  private _createAxesToMatchPoses(
    renderable: PoseArrayRenderable,
    poseArray: PoseArray,
    topic: string,
  ): void {
    const scale = renderable.userData.settings.axisScale * (1 / AXIS_LENGTH);

    // Update the scale and visibility of existing AxisRenderables as needed
    const existingUpdateCount = Math.min(renderable.userData.axes.length, poseArray.poses.length);
    for (let i = 0; i < existingUpdateCount; i++) {
      const axis = renderable.userData.axes[i]!;
      axis.visible = true;
      axis.scale.set(scale, scale, scale);
    }

    // Create any AxisRenderables as needed
    for (let i = renderable.userData.axes.length; i < poseArray.poses.length; i++) {
      // const axis = new Axis(topic, this.renderer);
      const axis = new AxisMark(topic, this.renderer,MARK_TYPE.NORMAL_MARK,true);
      renderable.userData.axes.push(axis);

      const label = this.renderer.labelPool.acquire();
      label.setBillboard(true);
      label.setText("点位");
      label.setLineHeight(0.2);
      label.visible = true;
      label.setColor(255,255,255);
      label.setBackgroundColor(0,0,0);
      renderable.userData.label.push(label);
      if(i%50==0){
        renderable.add(label);
        renderable.add(axis);
      }

      // Set the scale for each new axis
      axis.scale.set(scale, scale, scale);
    }

    // Hide any AxisRenderables as needed
    for (let i = poseArray.poses.length; i < renderable.userData.axes.length; i++) {
      const axis = renderable.userData.axes[i]!;
      axis.visible = false;
    }
  }
 
  private _updatePoseArrayRenderable(
    renderable: PoseArrayRenderable,
    poseArrayMessage: PoseArray,
    originalMessage: Record<string, RosValue>,
    receiveTime: bigint,
    settings: LayerSettingsPoseArray,
  ): void {
    renderable.userData.receiveTime = receiveTime;
    renderable.userData.messageTime = toNanoSec(poseArrayMessage.header.stamp);
    renderable.userData.frameId = this.renderer.normalizeFrameId(poseArrayMessage.header.frame_id);
    renderable.userData.poseArrayMessage = poseArrayMessage;
    renderable.userData.originalMessage = originalMessage;

    const { topic, settings: prevSettings } = renderable.userData;

    const axisOrArrowSettingsChanged =
      settings.type !== prevSettings.type ||
      settings.axisScale !== prevSettings.axisScale ||
      !vecEqual(settings.arrowScale, prevSettings.arrowScale) ||
      !vecEqual(settings.gradient, prevSettings.gradient) ||
      (renderable.userData.arrows.length === 0 && renderable.userData.axes.length === 0);
    if (axisOrArrowSettingsChanged){
      //暂时没有做任何处理 yxd maybe use
    }

    renderable.userData.settings = settings;
    
    // Update the pose for each pose renderable
    this._createAxesToMatchPoses(renderable, poseArrayMessage, topic);
    for (let i = 0; i < poseArrayMessage.poses.length; i++) {
      setObjectPose(renderable.userData.axes[i]!, poseArrayMessage.poses[i]!);
      setObjectPoseForLabel(renderable.userData.label[i]!, poseArrayMessage.poses[i]!);
    }   
  }
}

function getDefaultType(): DisplayType {
  return DEFAULT_TYPE;
}

function setObjectPose(object: THREE.Object3D, pose: Pose): void {
  const p = pose.position;
  const q = pose.orientation;
  object.position.set(p.x, p.y, p.z+0.2);
  object.quaternion.set(q.x, q.y, q.z, q.w);
  object.updateMatrix();
}

function setObjectPoseForLabel(object: THREE.Object3D, pose: Pose): void {
  const p = pose.position;
  const q = pose.orientation;
  object.position.set(p.x, p.y, p.z+0.5);
  object.quaternion.set(q.x, q.y, q.z, q.w);
  object.updateMatrix();
}

function normalizeNavPathToPoseArray(navPath: PartialMessage<NavPath>): PoseArray {
  return {
    header: normalizeHeader(navPath.header),
    poses: navPath.poses?.map((p) => normalizePose(p?.pose)) ?? [],
  };
}

function validateNavPath(messageEvent: PartialMessageEvent<NavPath>, renderer: IRenderer): boolean {
  const { topic, message: navPath } = messageEvent;
  if (navPath.poses) {
    const baseFrameId = renderer.normalizeFrameId(navPath.header?.frame_id ?? "");
    for (const pose of navPath.poses) {
      const curFrameId = renderer.normalizeFrameId(pose?.header?.frame_id ?? "");
      if (baseFrameId !== curFrameId) {
        renderer.settings.errors.addToTopic(
          topic,
          MISMATCHED_FRAME_ID,
          `Path poses must all have the same frame_id. "${baseFrameId}" != "${curFrameId}"`,
        );
        return false;
      }
    }
  }
  return true;
}
