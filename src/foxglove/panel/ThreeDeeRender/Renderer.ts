// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import EventEmitter from "eventemitter3";
import i18next from "i18next";
import { Immutable, produce } from "immer";
import * as THREE from "three";
import { DeepPartial } from "ts-essentials";
import { v4 as uuidv4 } from "uuid";

import { Time, fromNanoSec, isLessThan, toNanoSec } from "@foxglove/rostime";
import type { FrameTransform, FrameTransforms, SceneUpdate } from "@foxglove/schemas";
import {
  MessageEvent,
  ParameterValue,
  SettingsIcon,
  SettingsTreeAction,
  SettingsTreeNodeActionItem,
  SettingsTreeNodes,
  Topic,
  VariableValue,
} from "../../types/studio";
import { FoxgloveGrid } from "./renderables/FoxgloveGrid";
import { light, dark } from "@foxglove/studio-base/theme/palette";
import { fonts } from "../../util/sharedStyleConstants";
import { LabelMaterial, LabelPool } from "@foxglove/three-text";

import {
  IRenderer,
  InstancedLineMaterial,
  MessageHandler,
  RendererConfig,
  RendererEvents,
  RendererSubscription,
} from "./IRenderer";
import { Input } from "./Input";
import { LineMaterial } from "./LineMaterial";
import { ModelCache, DEFAULT_MESH_UP_AXIS } from "./ModelCache";
import { PickedRenderable, Picker } from "./Picker";
import type { Renderable } from "./Renderable";
import { SceneExtension } from "./SceneExtension";
import { ScreenOverlay } from "./ScreenOverlay";
import { SettingsManager, SettingsTreeEntry } from "./SettingsManager";
import { SharedGeometry } from "./SharedGeometry";
import { CameraState } from "./camera";
import { DARK_OUTLINE, LIGHT_OUTLINE, stringToRgb } from "./color";
import { FRAME_TRANSFORMS_DATATYPES, FRAME_TRANSFORM_DATATYPES } from "./foxglove";
import { DetailLevel, msaaSamples } from "./lod";
import {
  normalizeFrameTransform,
  normalizeFrameTransforms,
  normalizeTFMessage,
  normalizeTransformStamped,
} from "./normalizeMessages";
import { CameraStateSettings } from "./renderables/CameraStateSettings";
import { Cameras } from "./renderables/Cameras";
import { FrameAxes } from "./renderables/FrameAxes";
import { Grids } from "./renderables/Grids";
import { ImageMode } from "./renderables/ImageMode";
import { Images } from "./renderables/Images";
import { LaserScans } from "./renderables/LaserScans";
import { Markers } from "./renderables/Markers";
import { MeasurementTool } from "./renderables/MeasurementTool";
import { OccupancyGrids } from "./renderables/OccupancyGrids";
import { PointClouds } from "./renderables/PointClouds";
import { Polygons } from "./renderables/Polygons";
import { PoseArrays } from "./renderables/PoseArrays";
import { PoseArraysWayPoint } from "./renderables/PoseArraysWayPoint";//yxd waypoint
import { Poses } from "./renderables/Poses";
import { PublishClickTool } from "./renderables/PublishClickTool";
import { PublishSettings } from "./renderables/PublishSettings";
import { FoxgloveSceneEntities } from "./renderables/SceneEntities";
import { SceneSettings } from "./renderables/SceneSettings";
import { Urdfs } from "./renderables/Urdfs";
import { VelodyneScans } from "./renderables/VelodyneScans";
import { MarkerPool } from "./renderables/markers/MarkerPool";
import {
  Header,
  MarkerArray,
  Quaternion,
  TFMessage,
  TF_DATATYPES,
  TransformStamped,
  TRANSFORM_STAMPED_DATATYPES,
  Vector3,
} from "./ros";
import { SelectEntry } from "./settings";
import { AddTransformResult, CoordinateFrame, Transform, TransformTree } from "./transforms";
import { InterfaceMode } from "./types";

/** Legacy Image panel settings that occur at the root level */
export type LegacyImageConfig = {
  cameraTopic: string;
  enabledMarkerTopics: string[];
  synchronize: boolean;
  flipHorizontal: boolean;
  flipVertical: boolean;
  maxValue: number;
  minValue: number;
  mode: "fit" | "fill" | "other";
  pan: { x: number; y: number };
  rotation: number;
  smooth: boolean;
  transformMarkers: boolean;
  zoom: number;
  zoomPercentage: number;
};

/** Settings pertaining to Image mode */
export type ImageModeConfig = {
  /** Image topic to display */
  imageTopic?: string;
  /** Topic containing CameraCalibration or CameraInfo */
  calibrationTopic?: string;
};

/** Menu item entry and callback for the "Custom Layers" menu */
export type CustomLayerAction = {
  action: SettingsTreeNodeActionItem;
  handler: (instanceId: string) => void;
};

// Enable this to render the hitmap to the screen after clicking
const DEBUG_PICKING: boolean = false;

// Maximum number of objects to present as selection options in a single click
const MAX_SELECTIONS = 10;

// NOTE: These do not use .convertSRGBToLinear() since background color is not
// affected by gamma correction
const LIGHT_BACKDROP = new THREE.Color(light.background?.default);
const DARK_BACKDROP = new THREE.Color(dark.background?.default);

// Define rendering layers for multipass rendering used for the selection effect
const LAYER_DEFAULT = 0;
const LAYER_SELECTED = 1;

// Coordinate frames named in [REP-105](https://www.ros.org/reps/rep-0105.html)
const DEFAULT_FRAME_IDS = ["base_link", "odom", "map", "earth"];

const FOLLOW_TF_PATH = ["general", "followTf"];
const NO_FRAME_SELECTED = "NO_FRAME_SELECTED";
const FRAME_NOT_FOUND = "FRAME_NOT_FOUND";
const TF_OVERFLOW = "TF_OVERFLOW";
const CYCLE_DETECTED = "CYCLE_DETECTED";

// An extensionId for creating the top-level settings nodes such as "Topics" and
// "Custom Layers"
const RENDERER_ID = "foxglove.Renderer";

const tempColor = new THREE.Color();
const tempVec2 = new THREE.Vector2();

// We use a patched version of THREE.js where the internal WebGLShaderCache class has been
// modified to allow caching based on `vertexShaderKey` and/or `fragmentShaderKey` instead of
// using the full shader source as a Map key
Object.defineProperty(LabelMaterial.prototype, "vertexShaderKey", {
  get() {
    return "LabelMaterial-VertexShader";
  },
  enumerable: true,
  configurable: true,
});
Object.defineProperty(LabelMaterial.prototype, "fragmentShaderKey", {
  get() {
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
    return this.picking ? "LabelMaterial-FragmentShader-picking" : "LabelMaterial-FragmentShader";
  },
  enumerable: true,
  configurable: true,
});

/**
 * An extensible 3D renderer attached to a `HTMLCanvasElement`,
 * `WebGLRenderingContext`, and `SettingsTree`.
 */
export class Renderer extends EventEmitter<RendererEvents> implements IRenderer {
  public readonly interfaceMode: InterfaceMode;
  private canvas: HTMLCanvasElement;
  public readonly gl: THREE.WebGLRenderer;
  public maxLod = DetailLevel.High;
  public config: Immutable<RendererConfig>;
  public settings: SettingsManager;
  // [{ name, datatype }]
  public topics: ReadonlyArray<Topic> | undefined;
  // topicName -> { name, datatype }
  public topicsByName: ReadonlyMap<string, Topic> | undefined;
  // parameterKey -> parameterValue
  public parameters: ReadonlyMap<string, ParameterValue> | undefined;
  // variableName -> variableValue
  public variables: ReadonlyMap<string, VariableValue> = new Map();
  // extensionId -> SceneExtension
  public sceneExtensions = new Map<string, SceneExtension>();
  // datatype -> RendererSubscription[]
  public schemaHandlers = new Map<string, RendererSubscription[]>();
  // topicName -> RendererSubscription[]
  public topicHandlers = new Map<string, RendererSubscription[]>();
  // layerId -> { action, handler }
  private customLayerActions = new Map<string, CustomLayerAction>();
  private scene: THREE.Scene;
  private dirLight: THREE.DirectionalLight;
  private hemiLight: THREE.HemisphereLight;
  public input: Input;
  public readonly outlineMaterial = new THREE.LineBasicMaterial({ dithering: true });
  public readonly instancedOutlineMaterial = new InstancedLineMaterial({ dithering: true });

  /** only public for testing - prefer to use `getCameraState` instead */
  public cameraStateSettings: CameraStateSettings;

  public measurementTool: MeasurementTool;
  public publishClickTool: PublishClickTool;

  // Are we connected to a ROS data source? Normalize coordinate frames if so by
  // stripping any leading "/" prefix. See `normalizeFrameId()` for details.
  public ros = false;

  private picker: Picker;
  private selectionBackdrop: ScreenOverlay;
  private selectedRenderable: PickedRenderable | undefined;
  public colorScheme: "dark" | "light" = "light";
  public modelCache: ModelCache;
  public transformTree = new TransformTree();
  public coordinateFrameList: SelectEntry[] = [];
  public currentTime = 0n;
  public fixedFrameId: string | undefined;
  public renderFrameId: string | undefined;
  public followFrameId: string | undefined;

  public labelPool = new LabelPool({ fontFamily: fonts.MONOSPACE });
  public markerPool = new MarkerPool(this);
  public sharedGeometry = new SharedGeometry();

  private _prevResolution = new THREE.Vector2();
  private _pickingEnabled = false;
  private _animationFrame?: number;
  private _cameraSyncError: undefined | string;
  private _devicePixelRatioMediaQuery?: MediaQueryList;

  public constructor(
    canvas: HTMLCanvasElement,
    config: Immutable<RendererConfig>,
    interfaceMode: InterfaceMode,
  ) {
    super();
    // NOTE: Global side effect
    THREE.Object3D.DEFAULT_UP = new THREE.Vector3(0, 0, 1);

    this.interfaceMode = interfaceMode;
    this.canvas = canvas;
    this.config = config;

    this.settings = new SettingsManager(baseSettingsTree(this.interfaceMode));
    this.settings.on("update", () => this.emit("settingsTreeChange", this));
    // Add the top-level nodes first so merging happens in the correct order.
    // Another approach would be to modify SettingsManager to allow merging parent
    // nodes in after their children
    this.settings.setNodesForKey(RENDERER_ID, []);
    this.updateCustomLayersCount();

    this.gl = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
    });
    if (!this.gl.capabilities.isWebGL2) {
      throw new Error("WebGL2 is not supported");
    }
    this.gl.outputEncoding = THREE.sRGBEncoding;
    this.gl.toneMapping = THREE.NoToneMapping;
    this.gl.autoClear = false;
    this.gl.info.autoReset = false;
    this.gl.shadowMap.enabled = false;
    this.gl.shadowMap.type = THREE.VSMShadowMap;
    this.gl.sortObjects = true;
    this.gl.setPixelRatio(window.devicePixelRatio);

    let width = canvas.width;
    let height = canvas.height;
    if (canvas.parentElement) {
      width = canvas.parentElement.clientWidth;
      height = canvas.parentElement.clientHeight;
      this.gl.setSize(width, height);
    }

    this.modelCache = new ModelCache({
      ignoreColladaUpAxis: config.scene.ignoreColladaUpAxis ?? false,
      meshUpAxis: config.scene.meshUpAxis ?? DEFAULT_MESH_UP_AXIS,
      edgeMaterial: this.outlineMaterial,
    });

    this.scene = new THREE.Scene();

    this.dirLight = new THREE.DirectionalLight();
    this.dirLight.position.set(1, 1, 1);
    this.dirLight.castShadow = true;
    this.dirLight.layers.enableAll();

    this.dirLight.shadow.mapSize.width = 2048;
    this.dirLight.shadow.mapSize.height = 2048;
    this.dirLight.shadow.camera.near = 0.5;
    this.dirLight.shadow.camera.far = 500;
    this.dirLight.shadow.bias = -0.00001;

    this.hemiLight = new THREE.HemisphereLight(0xffffff, 0xffffff, 0.5);
    this.hemiLight.layers.enableAll();

    this.scene.add(this.dirLight);
    this.scene.add(this.hemiLight);

    this.input = new Input(canvas, () => this.cameraStateSettings.getActiveCamera());
    this.input.on("resize", (size) => this.resizeHandler(size));
    this.input.on("click", (cursorCoords) => this.clickHandler(cursorCoords));

    this.picker = new Picker(this.gl, this.scene, { debug: DEBUG_PICKING });

    this.selectionBackdrop = new ScreenOverlay(this);
    this.selectionBackdrop.visible = false;
    this.scene.add(this.selectionBackdrop);

    this.followFrameId = config.followTf;

    const renderSize = this.gl.getDrawingBufferSize(tempVec2);

    this.measurementTool = new MeasurementTool(this);
    this.publishClickTool = new PublishClickTool(this);
    this.cameraStateSettings = new CameraStateSettings(this, this.canvas, renderSize);

    // Internal handlers for TF messages to update the transform tree
    this.addSchemaSubscriptions(FRAME_TRANSFORM_DATATYPES, {
      handler: this.handleFrameTransform,
      shouldSubscribe: () => true,
      preload: config.scene.transforms?.enablePreloading ?? true,
    });
    this.addSchemaSubscriptions(FRAME_TRANSFORMS_DATATYPES, {
      handler: this.handleFrameTransforms,
      shouldSubscribe: () => true,
      preload: config.scene.transforms?.enablePreloading ?? true,
    });
    this.addSchemaSubscriptions(TF_DATATYPES, {
      handler: this.handleTFMessage,
      shouldSubscribe: () => true,
      preload: config.scene.transforms?.enablePreloading ?? true,
    });
    this.addSchemaSubscriptions(TRANSFORM_STAMPED_DATATYPES, {
      handler: this.handleTransformStamped,
      shouldSubscribe: () => true,
      preload: config.scene.transforms?.enablePreloading ?? true,
    });

    switch (interfaceMode) {
      case "image":
        this.addSceneExtension(new ImageMode(this));
        break;
      case "3d":
        this.addSceneExtension(this.cameraStateSettings);
        this.addSceneExtension(new PublishSettings(this));
        break;
    }

    this.addSceneExtension(new SceneSettings(this));
    this.addSceneExtension(new Cameras(this));
    this.addSceneExtension(new FrameAxes(this));//设置面板上的transform  yxd5
    this.addSceneExtension(new Grids(this));
    this.addSceneExtension(new Images(this));
    this.addSceneExtension(new Markers(this));//通过topic数据方式添加机器人模型
    this.addSceneExtension(new FoxgloveSceneEntities(this));
    this.addSceneExtension(new FoxgloveGrid(this));
    this.addSceneExtension(new LaserScans(this));//Topic中的scan
    this.addSceneExtension(new OccupancyGrids(this));//Topic中的map
    this.addSceneExtension(new PointClouds(this));
    this.addSceneExtension(new Polygons(this));
    this.addSceneExtension(new Poses(this));
    this.addSceneExtension(new PoseArrays(this));//Topic中的plan    yxd5
    this.addSceneExtension(new PoseArraysWayPoint(this)); //yxd waypoint
    this.addSceneExtension(new Urdfs(this));
    this.addSceneExtension(new VelodyneScans(this));
    this.addSceneExtension(this.measurementTool);
    this.addSceneExtension(this.publishClickTool);

    this._watchDevicePixelRatio();

    this.setCameraState(config.cameraState);
    this.animationFrame();
  }

  private _onDevicePixelRatioChange = () => {
    this.resizeHandler(this.input.canvasSize);
    this._watchDevicePixelRatio();
  };

  private _watchDevicePixelRatio() {
    this._devicePixelRatioMediaQuery = window.matchMedia(
      `(resolution: ${window.devicePixelRatio}dppx)`,
    );
    this._devicePixelRatioMediaQuery.addEventListener("change", this._onDevicePixelRatioChange, {
      once: true,
    });
  }

  public dispose(): void {
    this._devicePixelRatioMediaQuery?.removeEventListener("change", this._onDevicePixelRatioChange);
    this.removeAllListeners();

    this.settings.removeAllListeners();
    this.input.removeAllListeners();

    for (const extension of this.sceneExtensions.values()) {
      extension.dispose();
    }
    this.sceneExtensions.clear();
    this.sharedGeometry.dispose();
    this.modelCache.dispose();

    this.labelPool.dispose();
    this.markerPool.dispose();
    this.picker.dispose();
    this.input.dispose();
    this.gl.dispose();
  }

  public cameraSyncError(): undefined | string {
    return this._cameraSyncError;
  }

  public setCameraSyncError(error: undefined | string): void {
    this._cameraSyncError = error;
    // Updates the settings tree for camera state settings to account for any changes in the config.
    this.cameraStateSettings.updateSettingsTree();
  }

  public getPixelRatio(): number {
    return this.gl.getPixelRatio();
  }

  /**
   *
   * @param currentTime what renderer.currentTime will be set to
   */
  public setCurrentTime(newTimeNs: bigint): void {
    this.currentTime = newTimeNs;
  }
  /**
   * Updates renderer state according to seek delta. Handles clearing of future state and resetting of allFrames cursor if seeked backwards
   * Should be called after `setCurrentTime` as been called
   * @param oldTime used to determine if seeked backwards
   */
  public handleSeek(oldTimeNs: bigint): void {
    const movedBack = this.currentTime < oldTimeNs;
    // want to clear transforms and reset the cursor if we seek backwards
    this.clear({ clearTransforms: movedBack, resetAllFramesCursor: movedBack });
  }

  /**
   * Clears:
   *  - Rendered objects (a backfill is performed to ensure that they are regenerated with new messages from current frame)
   *  - Errors in settings. Messages that caused errors in the past are cleared, but will be re-added if they are still causing errors when read in.
   *  - [Optional] Transform tree. This should be set to true when a seek to a previous time is performed in order to flush potential future state to the newly set time.
   *  - [Optional] allFramesCursor. This is the cursor that iterates through allFrames up to currentTime. It should be reset when seeking backwards to avoid keeping future state.
   * @param {Object} params - modifiers to the clear operation
   * @param {boolean} params.clearTransforms - whether to clear the transform tree. This should be set to true when a seek to a previous time is performed in order
   * order to flush potential future state to the newly set time.
   * @param {boolean} params.resetAllFramesCursor - whether to reset the cursor for the allFrames array.
   */
  public clear(
    {
      clearTransforms,
      resetAllFramesCursor,
    }: { clearTransforms?: boolean; resetAllFramesCursor?: boolean } = {
      clearTransforms: false,
      resetAllFramesCursor: false,
    },
  ): void {
    if (clearTransforms === true) {
      this.transformTree.clear();
    }
    if (resetAllFramesCursor === true) {
      this._resetAllFramesCursor();
    }
    this.settings.errors.clear();

    for (const extension of this.sceneExtensions.values()) {
      extension.removeAllRenderables();
    }
  }

  private _allFramesCursor: {
    // index represents where the last read message is in allFrames
    index: number;
    cursorTimeReached?: Time;
  } = {
    index: -1,
    cursorTimeReached: undefined,
  };

  private _resetAllFramesCursor() {
    this._allFramesCursor = {
      index: -1,
      cursorTimeReached: undefined,
    };
  }

  /**
   * Iterates through allFrames and handles messages with a receiveTime <= currentTime
   * @param allFrames - array of all preloaded messages
   * @returns {boolean} - whether the allFramesCursor has been updated and new messages were read in
   */
  public handleAllFramesMessages(allFrames?: readonly MessageEvent<unknown>[]): boolean {
    const currentTime = fromNanoSec(this.currentTime);
    const allFramesCursor = this._allFramesCursor;
    // index always indicates last read-in message
    let cursor = allFramesCursor.index;
    let cursorTimeReached = allFramesCursor.cursorTimeReached;

    if (!allFrames || allFrames.length === 0) {
      // when tf preloading is disabled
      if (cursor > -1) {
        this._resetAllFramesCursor();
      }
      return false;
    }

    /**
     * Assumptions about allFrames needed by allFramesCursor:
     *  - always sorted by receiveTime
     *  - preloaded topics/schemas are only ever all removed or all added at once, otherwise it is not stable and would need to be reset
     *  - allFrame chunks are only ever loaded from beginning to end and does not have any eviction
     */

    // cursor should never be over allFramesLength, if it some how is, it means the cursor was at the end of `allFrames` prior to eviction and eviction shortened allframes
    // in this case we should set the cursor to the end of allFrames
    cursor = Math.min(cursor, allFrames.length - 1);
    let message;

    let hasAddedMessageEvents = false;
    // load preloaded messages up to current time
    while (cursor < allFrames.length - 1) {
      cursor++;
      message = allFrames[cursor]!;
      // read messages until we reach the current time
      if (isLessThan(currentTime, message.receiveTime)) {
        cursorTimeReached = currentTime;
        // reset cursor to last read message index
        cursor--;
        break;
      }
      if (!hasAddedMessageEvents) {
        hasAddedMessageEvents = true;
      }

      this.addMessageEvent(message);
      if (cursor === allFrames.length - 1) {
        cursorTimeReached = message.receiveTime;
      }
    }

    // want to avoid setting anything if nothing has changed
    if (!hasAddedMessageEvents) {
      return false;
    }

    this._allFramesCursor = { index: cursor, cursorTimeReached };
    return true;
  }

  private addSceneExtension(extension: SceneExtension): void {
    if (this.sceneExtensions.has(extension.extensionId)) {
      throw new Error(`Attempted to add duplicate extensionId "${extension.extensionId}"`);
    }
    this.sceneExtensions.set(extension.extensionId, extension);
    this.scene.add(extension);
  }

  public updateConfig(updateHandler: (draft: RendererConfig) => void): void {
    this.config = produce(this.config, updateHandler);
    this.emit("configChange", this);
  }

  public addSchemaSubscriptions<T>(
    schemaNames: Iterable<string>,
    subscription: RendererSubscription<T> | MessageHandler<T>,
  ): void {
    const genericSubscription =
      subscription instanceof Function
        ? { handler: subscription as MessageHandler<unknown> }
        : (subscription as RendererSubscription);
    for (const schemaName of schemaNames) {
      let handlers = this.schemaHandlers.get(schemaName);
      if (!handlers) {
        handlers = [];
        this.schemaHandlers.set(schemaName, handlers);
      }
      if (!handlers.includes(genericSubscription)) {
        handlers.push(genericSubscription);
      }
    }
    this.emit("schemaHandlersChanged", this);
  }

  public addTopicSubscription<T>(
    topic: string,
    subscription: RendererSubscription<T> | MessageHandler<T>,
  ): void {
    const genericSubscription =
      subscription instanceof Function
        ? { handler: subscription as MessageHandler<unknown> }
        : (subscription as RendererSubscription);
    let handlers = this.topicHandlers.get(topic);
    if (!handlers) {
      handlers = [];
      this.topicHandlers.set(topic, handlers);
    }
    if (!handlers.includes(genericSubscription)) {
      handlers.push(genericSubscription);
    }
    this.emit("topicHandlersChanged", this);
  }

  public addCustomLayerAction(options: {
    layerId: string;
    label: string;
    icon?: SettingsIcon;
    handler: (instanceId: string) => void;
  }): void {
    const handler = options.handler;
    // A unique id is assigned to each action to deduplicate selection events
    // The layerId is used to map selection events back to their handlers
    const instanceId = uuidv4();
    const action: SettingsTreeNodeActionItem = {
      type: "action",
      id: `${options.layerId}-${instanceId}`,
      label: options.label,
      icon: options.icon,
    };
    this.customLayerActions.set(options.layerId, { action, handler });

    // "Topics" settings tree node
    const topics: SettingsTreeEntry = {
      path: ["topics"],
      node: {
        enableVisibilityFilter: true,
        label: i18next.t("threeDee:topics"),
        defaultExpansionState: "expanded",
        actions: [
          { id: "show-all", type: "action", label: i18next.t("threeDee:showAll") },
          { id: "hide-all", type: "action", label: i18next.t("threeDee:hideAll") },
        ],
        children: this.settings.tree()["topics"]?.children,
        handler: this.handleTopicsAction,
      },
    };

    // "Custom Layers" settings tree node
    const layerCount = Object.keys(this.config.layers).length;
    const customLayers: SettingsTreeEntry = {
      path: ["layers"],
      node: {
        label: `${i18next.t("threeDee:customLayers")}${layerCount > 0 ? ` (${layerCount})` : ""}`,
        children: this.settings.tree()["layers"]?.children,
        actions: Array.from(this.customLayerActions.values()).map((entry) => entry.action),
        handler: this.handleCustomLayersAction,
      },
    };

    this.settings.setNodesForKey(RENDERER_ID, [topics, customLayers]);
  }

  private defaultFrameId(): string | undefined {
    const allFrames = this.transformTree.frames();
    if (allFrames.size === 0) {
      return undefined;
    }

    // Top priority is the followFrameId
    if (this.followFrameId != undefined) {
      return this.transformTree.hasFrame(this.followFrameId) ? this.followFrameId : undefined;
    }

    // Prefer frames from [REP-105](https://www.ros.org/reps/rep-0105.html)
    for (const frameId of DEFAULT_FRAME_IDS) {
      const frame = this.transformTree.frame(frameId);
      if (frame) {
        return frame.id;
      }
    }

    // Choose the root frame with the most children
    const rootsToCounts = new Map<string, number>();
    for (const frame of allFrames.values()) {
      const root = frame.root();
      const rootId = root.id;

      rootsToCounts.set(rootId, (rootsToCounts.get(rootId) ?? 0) + 1);
    }
    const rootsArray = Array.from(rootsToCounts.entries());
    const rootId = rootsArray.sort((a, b) => b[1] - a[1])[0]?.[0];
    return rootId;
  }

  /** Enable or disable object selection mode */
  // eslint-disable-next-line @foxglove/no-boolean-parameters
  public setPickingEnabled(enabled: boolean): void {
    this._pickingEnabled = enabled;
    if (!enabled) {
      this.setSelectedRenderable(undefined);
    }
  }

  /** Update the color scheme and background color, rebuilding any materials as necessary */
  public setColorScheme(colorScheme: "dark" | "light", backgroundColor: string | undefined): void {
    this.colorScheme = colorScheme;

    const bgColor = backgroundColor ? stringToRgb(tempColor, backgroundColor) : undefined;

    for (const extension of this.sceneExtensions.values()) {
      extension.setColorScheme(colorScheme, bgColor);
    }

    if (colorScheme === "dark") {
      this.gl.setClearColor(bgColor ?? DARK_BACKDROP);
      this.outlineMaterial.color.set(DARK_OUTLINE);
      this.outlineMaterial.needsUpdate = true;
      this.instancedOutlineMaterial.color.set(DARK_OUTLINE);
      this.instancedOutlineMaterial.needsUpdate = true;
      this.selectionBackdrop.setColor(DARK_BACKDROP, 0.8);
    } else {
      this.gl.setClearColor(bgColor ?? LIGHT_BACKDROP);
      this.outlineMaterial.color.set(LIGHT_OUTLINE);
      this.outlineMaterial.needsUpdate = true;
      this.instancedOutlineMaterial.color.set(LIGHT_OUTLINE);
      this.instancedOutlineMaterial.needsUpdate = true;
      this.selectionBackdrop.setColor(LIGHT_BACKDROP, 0.8);
    }
  }

  /** Update the list of topics and rebuild all settings nodes when the identity
   * of the topics list changes */
  public setTopics(topics: ReadonlyArray<Topic> | undefined): void {
    const changed = this.topics !== topics;
    this.topics = topics;
    if (changed) {
      // Rebuild topicsByName
      this.topicsByName = topics ? new Map(topics.map((topic) => [topic.name, topic])) : undefined;

      // Rebuild the settings nodes for all scene extensions
      for (const extension of this.sceneExtensions.values()) {
        this.settings.setNodesForKey(extension.extensionId, extension.settingsNodes());
      }
    }
  }

  public setParameters(parameters: ReadonlyMap<string, ParameterValue> | undefined): void {
    const changed = this.parameters !== parameters;
    this.parameters = parameters;
    if (changed) {
      this.emit("parametersChange", parameters, this);
    }
  }

  public setVariables(variables: ReadonlyMap<string, VariableValue>): void {
    const changed = this.variables !== variables;
    this.variables = variables;
    if (changed) {
      this.emit("variablesChange", variables, this);
    }
  }

  public updateCustomLayersCount(): void {
    const layerCount = Object.keys(this.config.layers).length;
    const label = `自定义图层${layerCount > 0 ? ` (${layerCount})` : ""}`;
    // const label = `自定义图层${layerCount > 0 ? ` (${layerCount})` : ""}`;  yxd 2023-05-08
    this.settings.setLabel(["layers"], label);
  }

  public setCameraState(cameraState: CameraState): void {
    this.cameraStateSettings.setCameraState(cameraState);
  }

  public getCameraState(): CameraState {
    return this.cameraStateSettings.getCameraState();
  }

  public setSelectedRenderable(selection: PickedRenderable | undefined): void {
    if (this.selectedRenderable === selection) {
      return;
    }

    const prevSelected = this.selectedRenderable;
    if (prevSelected) {
      // Deselect the previously selected renderable
      deselectObject(prevSelected.renderable);
    }

    this.selectedRenderable = selection;

    if (selection) {
      // Select the newly selected renderable
      selectObject(selection.renderable);
    }

    this.emit("selectedRenderable", selection, this);

    if (!DEBUG_PICKING) {
      this.animationFrame();
    }
  }

  public addMessageEvent(messageEvent: Readonly<MessageEvent<unknown>>): void {
    const { message } = messageEvent;

    const maybeHasHeader = message as DeepPartial<{ header: Header }>;
    const maybeHasMarkers = message as DeepPartial<MarkerArray>;
    const maybeHasEntities = message as DeepPartial<SceneUpdate>;
    const maybeHasFrameId = message as DeepPartial<Header>;

    // Extract coordinate frame IDs from all incoming messages
    if (maybeHasHeader.header) {
      // If this message has a Header, scrape the frame_id from it
      const frameId = maybeHasHeader.header.frame_id ?? "";
      this.addCoordinateFrame(frameId);
    } else if (Array.isArray(maybeHasMarkers.markers)) {
      // If this message has an array called markers, scrape frame_id from all markers
      for (const marker of maybeHasMarkers.markers) {
        if (marker) {
          const frameId = marker.header?.frame_id ?? "";
          this.addCoordinateFrame(frameId);
        }
      }
    } else if (Array.isArray(maybeHasEntities.entities)) {
      // If this message has an array called entities, scrape frame_id from all entities
      for (const entity of maybeHasEntities.entities) {
        if (entity) {
          const frameId = entity.frame_id ?? "";
          this.addCoordinateFrame(frameId);
        }
      }
    } else if (typeof maybeHasFrameId.frame_id === "string") {
      // If this message has a top-level frame_id, scrape it
      this.addCoordinateFrame(maybeHasFrameId.frame_id);
    }

    handleMessage(messageEvent, this.topicHandlers.get(messageEvent.topic));
    handleMessage(messageEvent, this.schemaHandlers.get(messageEvent.schemaName));
  }

  /** Match the behavior of `tf::Transformer` by stripping leading slashes from
   * frame_ids. This preserves compatibility with earlier versions of ROS while
   * not breaking any current versions where:
   * > tf2 does not accept frame_ids starting with "/"
   * Source: <http://wiki.ros.org/tf2/Migration#tf_prefix_backwards_compatibility>
   */
  public normalizeFrameId(frameId: string): string {
    if (!this.ros || !frameId.startsWith("/")) {
      return frameId;
    }
    return frameId.slice(1);
  }

  public addCoordinateFrame(frameId: string): void {
    const normalizedFrameId = this.normalizeFrameId(frameId);
    if (!this.transformTree.hasFrame(normalizedFrameId)) {
      this.transformTree.getOrCreateFrame(normalizedFrameId);
      this.coordinateFrameList = this.transformTree.frameList();
      // log.debug(`Added coordinate frame "${normalizedFrameId}"`);
      this.emit("transformTreeUpdated", this);
    }
  }

  private addFrameTransform(transform: FrameTransform): void {
    const parentId = transform.parent_frame_id;
    const childId = transform.child_frame_id;
    const stamp = toNanoSec(transform.timestamp);
    const t = transform.translation;
    const q = transform.rotation;

    this.addTransform(parentId, childId, stamp, t, q);
  }

  private addTransformMessage(tf: TransformStamped): void {
    const normalizedParentId = this.normalizeFrameId(tf.header.frame_id);
    const normalizedChildId = this.normalizeFrameId(tf.child_frame_id);
    const stamp = toNanoSec(tf.header.stamp);
    const t = tf.transform.translation;
    const q = tf.transform.rotation;

    this.addTransform(normalizedParentId, normalizedChildId, stamp, t, q);
  }

  // Create a new transform and add it to the renderer's TransformTree
  public addTransform(
    parentFrameId: string,
    childFrameId: string,
    stamp: bigint,
    translation: Vector3,
    rotation: Quaternion,
    errorSettingsPath?: string[],
  ): void {
    const t = translation;
    const q = rotation;

    const transform = new Transform([t.x, t.y, t.z], [q.x, q.y, q.z, q.w]);
    const status = this.transformTree.addTransform(childFrameId, parentFrameId, stamp, transform);

    if (status === AddTransformResult.UPDATED) {
      this.coordinateFrameList = this.transformTree.frameList();
      this.emit("transformTreeUpdated", this);
    }

    if (status === AddTransformResult.CYCLE_DETECTED) {
      this.settings.errors.add(
        ["transforms", `frame:${childFrameId}`],
        CYCLE_DETECTED,
        `Transform tree cycle detected: Received transform with parent "${parentFrameId}" and child "${childFrameId}", but "${childFrameId}" is already an ancestor of "${parentFrameId}". Transform message dropped.`,
      );
      if (errorSettingsPath) {
        this.settings.errors.add(
          errorSettingsPath,
          CYCLE_DETECTED,
          `Attempted to add cyclical transform: Frame "${parentFrameId}" cannot be the parent of frame "${childFrameId}". Transform message dropped.`,
        );
      }
    }

    // Check if the transform history for this frame is at capacity and show an error if so. This
    // error can't be cleared until the scene is reloaded
    const frame = this.transformTree.getOrCreateFrame(childFrameId);
    if (frame.transformsSize() === frame.maxCapacity) {
      this.settings.errors.add(
        ["transforms", `frame:${childFrameId}`],
        TF_OVERFLOW,
        `[Warning] Transform history is at capacity (${frame.maxCapacity}), old TFs will be dropped`,
      );
    }
  }

  public removeTransform(childFrameId: string, parentFrameId: string, stamp: bigint): void {
    this.transformTree.removeTransform(childFrameId, parentFrameId, stamp);
    this.coordinateFrameList = this.transformTree.frameList();
    this.emit("transformTreeUpdated", this);
  }

  // Callback handlers

  public animationFrame = (): void => {
    this._animationFrame = undefined;
    this.frameHandler(this.currentTime);
  };

  public queueAnimationFrame(): void {
    if (this._animationFrame == undefined) {
      this._animationFrame = requestAnimationFrame(this.animationFrame);
    }
  }

  private frameHandler = (currentTime: bigint): void => {
    this.currentTime = currentTime;
    this._updateFrames();
    this._updateResolution();

    this.gl.clear();
    this.emit("startFrame", currentTime, this);

    const camera = this.cameraStateSettings.getActiveCamera();
    camera.layers.set(LAYER_DEFAULT);
    this.selectionBackdrop.visible = this.selectedRenderable != undefined;

    // use the FALLBACK_FRAME_ID if renderFrame is undefined and there are no options for transforms
    const renderFrameId = this.renderFrameId ?? CoordinateFrame.FALLBACK_FRAME_ID;
    const fixedFrameId = this.fixedFrameId ?? CoordinateFrame.FALLBACK_FRAME_ID;

    for (const sceneExtension of this.sceneExtensions.values()) {
      sceneExtension.startFrame(currentTime, renderFrameId, fixedFrameId);
    }

    this.gl.render(this.scene, camera);

    if (this.selectedRenderable) {
      this.gl.clearDepth();
      camera.layers.set(LAYER_SELECTED);
      this.selectionBackdrop.visible = false;
      this.gl.render(this.scene, camera);
    }

    this.emit("endFrame", currentTime, this);

    this.gl.info.reset();
  };

  private resizeHandler = (size: THREE.Vector2): void => {
    this.gl.setPixelRatio(window.devicePixelRatio);
    this.gl.setSize(size.width, size.height);

    const renderSize = this.gl.getDrawingBufferSize(tempVec2);
    this.cameraStateSettings.handleResize(renderSize);

    this.animationFrame();
  };

  private clickHandler = (cursorCoords: THREE.Vector2): void => {
    if (!this._pickingEnabled) {
      this.setSelectedRenderable(undefined);
      return;
    }

    // Disable picking while a tool is active
    if (this.measurementTool.state !== "idle" || this.publishClickTool.state !== "idle") {
      return;
    }

    // Deselect the currently selected object, if one is selected and re-render
    // the scene to update the render lists
    this.setSelectedRenderable(undefined);

    // Pick a single renderable, hide it, re-render, and run picking again until
    // the backdrop is hit or we exceed MAX_SELECTIONS
    const camera = this.cameraStateSettings.getActiveCamera();
    const selections: PickedRenderable[] = [];
    let curSelection: PickedRenderable | undefined;
    while (
      (curSelection = this._pickSingleObject(cursorCoords)) &&
      selections.length < MAX_SELECTIONS
    ) {
      selections.push(curSelection);
      curSelection.renderable.visible = false;
      this.gl.render(this.scene, camera);
    }

    // Put everything back to normal and render one last frame
    for (const selection of selections) {
      selection.renderable.visible = true;
    }
    if (!DEBUG_PICKING) {
      this.animationFrame();
    }

    this.emit("renderablesClicked", selections, cursorCoords, this);
  };

  private handleFrameTransform = ({ message }: MessageEvent<DeepPartial<FrameTransform>>): void => {
    // foxglove.FrameTransform - Ingest this single transform into our TF tree
    const transform = normalizeFrameTransform(message);
    this.addFrameTransform(transform);
  };

  private handleFrameTransforms = ({
    message,
  }: MessageEvent<DeepPartial<FrameTransforms>>): void => {
    // foxglove.FrameTransforms - Ingest the list of transforms into our TF tree
    const frameTransforms = normalizeFrameTransforms(message);
    for (const transform of frameTransforms.transforms) {
      this.addFrameTransform(transform);
    }
  };

  private handleTFMessage = ({ message }: MessageEvent<DeepPartial<TFMessage>>): void => {
    // tf2_msgs/TFMessage - Ingest the list of transforms into our TF tree
    const tfMessage = normalizeTFMessage(message);
    for (const tf of tfMessage.transforms) {
      this.addTransformMessage(tf);
    }
  };

  private handleTransformStamped = ({
    message,
  }: MessageEvent<DeepPartial<TransformStamped>>): void => {
    // geometry_msgs/TransformStamped - Ingest this single transform into our TF tree
    const tf = normalizeTransformStamped(message);
    this.addTransformMessage(tf);
  };

  private handleTopicsAction = (action: SettingsTreeAction): void => {
    const path = action.payload.path;
    if (action.action !== "perform-node-action" || path.length !== 1 || path[0] !== "topics") {
      return;
    }

    // eslint-disable-next-line @foxglove/no-boolean-parameters
    const toggleTopicVisibility = (value: boolean) => {
      for (const extension of this.sceneExtensions.values()) {
        for (const node of extension.settingsNodes()) {
          if (node.path[0] === "topics") {
            extension.handleSettingsAction({
              action: "update",
              payload: { path: [...node.path, "visible"], input: "boolean", value },
            });
          }
        }
      }
    };

    if (action.payload.id === "show-all") {
      // Show all topics
      toggleTopicVisibility(true);
    } else if (action.payload.id === "hide-all") {
      // Hide all topics
      toggleTopicVisibility(false);
    }
  };

  private handleCustomLayersAction = (action: SettingsTreeAction): void => {
    const path = action.payload.path;
    if (action.action !== "perform-node-action" || path.length !== 1 || path[0] !== "layers") {
      return;
    }

    // Remove `-{uuid}` from the actionId to get the layerId
    const actionId = action.payload.id;
    const layerId = actionId.slice(0, -37);
    const instanceId = actionId.slice(-36);

    const entry = this.customLayerActions.get(layerId);
    if (!entry) {
      throw new Error(`No custom layer action found for "${layerId}"`);
    }

    // Regenerate the action menu entry with a new instanceId. The unique instanceId is generated
    // here so we can deduplicate multiple callbacks for the same menu click event
    const { label, icon } = entry.action;
    this.addCustomLayerAction({ layerId, label, icon, handler: entry.handler });

    // Trigger the add custom layer action handler
    entry.handler(instanceId);

    // Update the Custom Layers node label with the number of custom layers
    this.updateCustomLayersCount();
  };

  private _pickSingleObject(cursorCoords: THREE.Vector2): PickedRenderable | undefined {
    // Render a single pixel using a fragment shader that writes object IDs as
    // colors, then read the value of that single pixel back
    const objectId = this.picker.pick(
      cursorCoords.x,
      cursorCoords.y,
      this.cameraStateSettings.getActiveCamera(),
    );
    if (objectId === -1) {
      return undefined;
    }

    // Traverse the scene looking for this objectId
    const pickedObject = this.scene.getObjectById(objectId);

    // Find the highest ancestor of the picked object that is a Renderable
    let renderable: Renderable | undefined;
    let maybeRenderable = pickedObject as Partial<Renderable> | undefined;
    while (maybeRenderable) {
      if (maybeRenderable.pickable === true) {
        renderable = maybeRenderable as Renderable;
      }
      maybeRenderable = (maybeRenderable.parent ?? undefined) as Partial<Renderable> | undefined;
    }

    if (!renderable) {
      return undefined;
    }

    let instanceIndex: number | undefined;
    if (renderable.pickableInstances) {
      instanceIndex = this.picker.pickInstance(
        cursorCoords.x,
        cursorCoords.y,
        this.cameraStateSettings.getActiveCamera(),
        renderable,
      );
      instanceIndex = instanceIndex === -1 ? undefined : instanceIndex;
    }

    return { renderable, instanceIndex };
  }

  /** Tracks the number of frames so we can recompute the defaultFrameId when frames are added. */
  private _lastTransformFrameCount = 0;

  private _updateFrames(): void {
    if (
      this.followFrameId != undefined &&
      this.renderFrameId !== this.followFrameId &&
      this.transformTree.hasFrame(this.followFrameId)
    ) {
      // followFrameId is set and is a valid frame, use it
      this.renderFrameId = this.followFrameId;
    } else if (
      this.renderFrameId == undefined ||
      this.transformTree.frames().size !== this._lastTransformFrameCount ||
      !this.transformTree.hasFrame(this.renderFrameId)
    ) {
      // No valid renderFrameId set, or new frames have been added, fall back to selecting the
      // heuristically most valid frame (if any frames are present)
      this.renderFrameId = this.defaultFrameId();
      this._lastTransformFrameCount = this.transformTree.frames().size;

      if (this.renderFrameId == undefined) {
        if (this.followFrameId != undefined) {
          this.settings.errors.add(
            FOLLOW_TF_PATH,
            FRAME_NOT_FOUND,
            i18next.t("threeDee:frameNotFound", {
              followFrameId: this.followFrameId,
            }),
          );
        } else {
          this.settings.errors.add(
            FOLLOW_TF_PATH,
            NO_FRAME_SELECTED,
            i18next.t("threeDee:noCoordinateFramesFound"),
          );
        }
        this.fixedFrameId = undefined;
        return;
      } else {
        this.settings.errors.remove(FOLLOW_TF_PATH, NO_FRAME_SELECTED);
      }
    }

    const frame = this.transformTree.frame(this.renderFrameId);
    if (!frame) {
      this.renderFrameId = undefined;
      this.fixedFrameId = undefined;
      this.settings.errors.add(
        FOLLOW_TF_PATH,
        FRAME_NOT_FOUND,
        i18next.t("threeDee:frameNotFound", {
          followFrameId: this.renderFrameId,
        }),
      );
      return;
    } else {
      this.settings.errors.remove(FOLLOW_TF_PATH, FRAME_NOT_FOUND);
    }

    const fixedFrame = frame.root();
    const fixedFrameId = fixedFrame.id;
    if (this.fixedFrameId !== fixedFrameId) {
      if (this.fixedFrameId == undefined) {
      } else {
      }
      this.fixedFrameId = fixedFrameId;
    }

    this.settings.errors.clearPath(FOLLOW_TF_PATH);
  }

  private _updateResolution(): void {
    const resolution = this.input.canvasSize;
    if (this._prevResolution.equals(resolution)) {
      return;
    }
    this._prevResolution.copy(resolution);

    this.scene.traverse((object) => {
      if ((object as Partial<THREE.Mesh>).material) {
        const mesh = object as THREE.Mesh;
        const material = mesh.material as Partial<LineMaterial>;

        // Update render resolution uniforms
        if (material.resolution) {
          material.resolution.copy(resolution);
        }
        if (material.uniforms?.resolution) {
          material.uniforms.resolution.value = resolution;
        }
      }
    });
  }
}

function handleMessage(
  messageEvent: Readonly<MessageEvent<unknown>>,
  subscriptions: RendererSubscription[] | undefined,
): void {
  if (subscriptions) {
    for (const subscription of subscriptions) {
      subscription.handler(messageEvent);
    }
  }
}

function selectObject(object: THREE.Object3D) {
  object.layers.set(LAYER_SELECTED);
  object.traverse((child) => {
    child.layers.set(LAYER_SELECTED);
  });
}

function deselectObject(object: THREE.Object3D) {
  object.layers.set(LAYER_DEFAULT);
  object.traverse((child) => {
    child.layers.set(LAYER_DEFAULT);
  });
}

/**
 * Creates a skeleton settings tree. The tree contents are filled in by scene extensions.
 * This dictates the order in which groups appear in the settings editor.
 */
function baseSettingsTree(interfaceMode: InterfaceMode): SettingsTreeNodes {
  const keys: string[] = [];
  keys.push(interfaceMode === "image" ? "imageMode" : "general", "scene");
  if (interfaceMode === "3d") {
    keys.push("cameraState");
  }
  keys.push("transforms", "topics", "layers");
  if (interfaceMode === "3d") {
    keys.push("publish");
  }
  return Object.fromEntries(keys.map((key) => [key, {}]));
}
