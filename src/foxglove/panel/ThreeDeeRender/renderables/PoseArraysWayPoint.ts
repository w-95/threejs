// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import * as THREE from "three";

import { toNanoSec } from "@foxglove/rostime";
import { SettingsTreeAction, SettingsTreeFields } from "@foxglove/studio";
import type { RosValue } from "@foxglove/studio-base/players/types";

import { AxisMark, AXIS_LENGTH, MARK_TYPE } from "./AxisMark"; //waypoint

import type { IRenderer } from "../IRenderer";
import { BaseUserData, Renderable } from "../Renderable";
import { PartialMessage, PartialMessageEvent, SceneExtension } from "../SceneExtension";
import { SettingsTreeEntry } from "../SettingsManager";
import { rgbaToCssString } from "../color";
import { vecEqual } from "../math";
import { normalizeHeader, normalizePose } from "../normalizeMessages";
import {
  ColorRGBA,
  WAY_POINT_DATATYPES,
  WayPoint,// yxd wayPoint
  WayPointArray,// yxd wayPoint
  RobotWayPoint,// yxd wayPoint
} from "../ros";
import {
  BaseSettings,
  // fieldGradient,
  fieldSize,
  PRECISION_DISTANCE,
} from "../settings";
import { topicIsConvertibleToSchema } from "../topicIsConvertibleToSchema";
import { makePose, Pose } from "../transforms";
import { Label } from "@foxglove/three-text";

type GradientRgba = [ColorRGBA, ColorRGBA];
type Gradient = [string, string];
type DisplayType = "axis" | "arrow" | "line";
//设置选项
export type LayerSettingsPoseArrayWayPoint = BaseSettings & {
  axisScale: number;
  gradient: Gradient;
};

const DEFAULT_TYPE: DisplayType = "axis";
const DEFAULT_AXIS_SCALE = AXIS_LENGTH;
const DEFAULT_GRADIENT: GradientRgba = [
  { r: 124 / 255, g: 107 / 255, b: 1, a: 1 },
  { r: 124 / 255, g: 107 / 255, b: 1, a: 0.5 },
];

const DEFAULT_GRADIENT_STR: Gradient = [
  rgbaToCssString(DEFAULT_GRADIENT[0]!),
  rgbaToCssString(DEFAULT_GRADIENT[1]!),
];

//设置选项的默认值 maybe use
const DEFAULT_SETTINGS: LayerSettingsPoseArrayWayPoint = {
  visible: false,
  axisScale: DEFAULT_AXIS_SCALE,
  gradient: DEFAULT_GRADIENT_STR,
};

export type PoseArrayUserData = BaseUserData & {
  settings: LayerSettingsPoseArrayWayPoint;
  topic: string;
  wayPointArrayMessage: WayPointArray; //waypoint
  originalMessage: Record<string, RosValue>;
  axes: AxisMark[];
  label:Label[];
};

export class PoseArrayRenderable extends Renderable<PoseArrayUserData> {
  public override dispose(): void {
    this.userData.axes.forEach((axis) => axis.dispose());
    super.dispose();
  }

  public override details(): Record<string, RosValue> {
    return this.userData.originalMessage;
  }

  public removeAxes(): void {
    for (const axis of this.userData.axes) {
      this.remove(axis);
      axis.dispose();
    }
    this.userData.axes.length = 0;
  }
}
// yxd waypoint
export class PoseArraysWayPoint extends SceneExtension<PoseArrayRenderable> {
  public constructor(renderer: IRenderer) {
    super("robot_interfaces.PoseArrays", renderer);
    //添加主题订阅，当有相关数据来的时候会触发执行
    renderer.addSchemaSubscriptions(WAY_POINT_DATATYPES, this.handleWayPoint);
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
          topicIsConvertibleToSchema(topic, WAY_POINT_DATATYPES) 
        )
      ) {        
        continue;
      }
      const config = (configTopics[topic.name] ?? {}) as Partial<LayerSettingsPoseArrayWayPoint>;
      const { axisScale } = config;
      // const gradient = config.gradient ?? DEFAULT_GRADIENT_STR;

      const fields: SettingsTreeFields = {};
      fields["axisScale"] = fieldSize("Scale", axisScale, PRECISION_DISTANCE);
      // fields["gradient"] = fieldGradient("Gradient", gradient);

      entries.push({
        path: ["topics", topic.name],
        node: {
          label: topic.name,
          icon: topicIsConvertibleToSchema(topic, WAY_POINT_DATATYPES) ? "Timeline" : "Flag",
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
        | Partial<LayerSettingsPoseArrayWayPoint>
        | undefined;
      const defaultType = { type: getDefaultType() };
      this._updatePoseArrayRenderable(
        renderable,
        renderable.userData.wayPointArrayMessage,
        renderable.userData.originalMessage,
        renderable.userData.receiveTime,
        { ...DEFAULT_SETTINGS, ...defaultType, ...settings },
      );
    }
  };
  //robot_interfaces/wayPoint这种主题数据接收到时触发
  private handleWayPoint = (messageEvent: PartialMessageEvent<WayPointArray>): void => {
    const wayPointArrayMessage = normalizeMessageToPoseArrayWayPoint(messageEvent.message);
    const receiveTime = toNanoSec(messageEvent.receiveTime);
    this.addPoseArray(messageEvent.topic, wayPointArrayMessage, messageEvent.message, receiveTime);
  };

  private addPoseArray(
    topic: string,
    wayPointArrayMessage: WayPointArray,
    originalMessage: Record<string, RosValue>,
    receiveTime: bigint,
  ): void {
    let renderable = this.renderables.get(topic);

    if (!renderable) {
      // Set the initial settings from default values merged with any user settings
      const userSettings = this.renderer.config.topics[topic] as
        | Partial<LayerSettingsPoseArrayWayPoint>
        | undefined;
      const defaultType = { type: getDefaultType() };
      const settings = { ...DEFAULT_SETTINGS, ...defaultType, ...userSettings };

      renderable = new PoseArrayRenderable(topic, this.renderer, {
        receiveTime,
        messageTime: toNanoSec(wayPointArrayMessage.header.stamp),
        frameId: this.renderer.normalizeFrameId(wayPointArrayMessage.header.frame_id),
        pose: makePose(),
        settingsPath: ["topics", topic],
        settings,
        topic,
        wayPointArrayMessage,
        originalMessage,
        axes: [],
        label:[],
      });

      this.add(renderable);
      this.renderables.set(topic, renderable);
    }

    this._updatePoseArrayRenderable(
      renderable,
      wayPointArrayMessage,
      originalMessage,
      receiveTime,
      renderable.userData.settings,
    );
  }

  private _createAxesToMatchPoses(
    renderable: PoseArrayRenderable,
    wayPointArray: WayPointArray,
    topic: string,
  ): void {
    const scale = renderable.userData.settings.axisScale * (1 / AXIS_LENGTH);
 // Update the scale and visibility of existing AxisRenderables as needed
    const existingUpdateCount = Math.min(renderable.userData.axes.length, wayPointArray.wayPoints.length);
    for (let i = 0; i < existingUpdateCount; i++) {
      const axis = renderable.userData.axes[i]!;
      axis.visible = true;
      axis.scale.set(scale, scale, scale);
    }
    // Create any AxisRenderables as needed
    // for (let i = 0; i < wayPointArray.wayPoints.length; i++) {
    for (let i = renderable.userData.axes.length; i < wayPointArray.wayPoints.length; i++) {
      if(wayPointArray.wayPoints[i]?.point_type==0){
        const axis = new AxisMark(topic, this.renderer,MARK_TYPE.NORMAL_MARK,true);
        renderable.userData.axes.push(axis);
        renderable.add(axis);
        axis.scale.set(scale, scale, scale);
      }
      else if(wayPointArray.wayPoints[i]?.point_type==1){
        const axis = new AxisMark(topic, this.renderer,MARK_TYPE.CHARGE_MARK,true);
        renderable.userData.axes.push(axis);
        renderable.add(axis);
        axis.scale.set(scale, scale, scale);
      }    

      const title = wayPointArray.wayPoints[i]?.point_name as string;
      const label = this.renderer.labelPool.acquire();
      label.setBillboard(true);
      label.setText(title);
      label.setLineHeight(0.2);
      label.visible = true;
      label.setColor(255,255,255);
      label.setBackgroundColor(0,0,0);
      renderable.userData.label.push(label);
      renderable.add(label);
    }
  }
 
  private _updatePoseArrayRenderable(
    renderable: PoseArrayRenderable,
    wayPointArrayMessage: WayPointArray,
    originalMessage: Record<string, RosValue>,
    receiveTime: bigint,
    settings: LayerSettingsPoseArrayWayPoint,
  ): void {
    renderable.userData.receiveTime = receiveTime;
    renderable.userData.messageTime = toNanoSec(wayPointArrayMessage.header.stamp);
    renderable.userData.frameId = this.renderer.normalizeFrameId(wayPointArrayMessage.header.frame_id);
    renderable.userData.wayPointArrayMessage = wayPointArrayMessage;
    renderable.userData.originalMessage = originalMessage;

    const { topic, settings: prevSettings } = renderable.userData;

    const axisOrArrowSettingsChanged =
      settings.axisScale !== prevSettings.axisScale ||
      !vecEqual(settings.gradient, prevSettings.gradient);
    if (axisOrArrowSettingsChanged){
      //暂时没有做任何处理 yxd maybe use
    }

    renderable.userData.settings = settings;
    
    // Update the pose for each pose renderable
    this._createAxesToMatchPoses(renderable, wayPointArrayMessage, topic);
    for (let i = 0; i < wayPointArrayMessage.wayPoints.length; i++) {
      setObjectPose(renderable.userData.axes[i]!, wayPointArrayMessage.wayPoints[i]?.poses!);
      setObjectPoseForLabel(renderable.userData.label[i]!, wayPointArrayMessage.wayPoints[i]?.poses!);
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

//yxd waypoint
function normalizeMessageToPoseArrayWayPoint(robotWayPoint: PartialMessage<RobotWayPoint>): WayPointArray {
  return {
    header: normalizeHeader(robotWayPoint.header),
    wayPoints:robotWayPoint.points?.map((wp) => normalizeWayPoint(wp))??[],
  };
}

function normalizeWayPoint(waypoint: PartialMessage<WayPoint> | undefined): WayPoint {
  return {
    point_type:waypoint?.point_type as number,
    point_name:waypoint?.point_name,
    point_id:waypoint?.point_id,
    poses:normalizePose(waypoint?.poses),
  }
}