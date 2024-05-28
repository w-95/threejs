// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/
// remove panellist without 3D panel 2023-04-18 yxd
import { TFunction } from "i18next";

import { PanelInfo } from "../context/PanelCatalogContext";
import threeDeeRenderThumbnail from "./ThreeDeeRender/thumbnail.png";

export const getBuiltin: (t: TFunction<"panels">) => PanelInfo[] = (t) => [
  {
    title: t("3D"),
    type: "3D",
    description: t("3DPanelDescription"),
    thumbnail: threeDeeRenderThumbnail,
    module: async () => ({ default: (await import("./ThreeDeeRender")).ThreeDeePanel }),
    settingsOnboardingTooltip: t("3DPanelSettingsOnboardingTooltip"),
  },
];
// 元素代码 yxd maybe use
// export const getDebug: (t: TFunction<"panels">) => PanelInfo[] = (t) => [
//   {
//     title: t("studioPlaybackPerformance"),
//     type: "PlaybackPerformance",
//     description: t("studioPlaybackPerformanceDescription"),
//     module: async () => await import("./PlaybackPerformance"),
//   },
// ];
// 修改后代码
export const getDebug: (t: TFunction<"panels">) => PanelInfo[] = () => [
  // {
  //   title: t("studioPlaybackPerformance"),
  //   type: "PlaybackPerformance",
  //   description: t("studioPlaybackPerformanceDescription"),
  //   module: async () => await import("./PlaybackPerformance"),
  // },
];

export const getLegacyPlot: (t: TFunction<"panels">) => PanelInfo = (t) => ({
  title: t("legacyPlot"),
  type: "LegacyPlot",
  module: async () => await import("./LegacyPlot"),
});

export const getNewImage: (t: TFunction<"panels">) => PanelInfo = (t) => ({
  title: t("newImage"),
  type: "Image",
  module: async () => ({ default: (await import("./ThreeDeeRender")).ImagePanel }),
});
