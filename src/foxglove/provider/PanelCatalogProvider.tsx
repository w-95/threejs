// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { PropsWithChildren, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { AppSetting } from "../AppSetting";
import Panel from "../panel/Panel";
import { useExtensionCatalog } from "@foxglove/studio-base/context/ExtensionCatalogContext";
import PanelCatalogContext, {
  PanelCatalog,
  PanelInfo,
} from "../context/PanelCatalogContext";
import { useAppConfigurationValue } from "../hooks/useAppConfigurationValue";
import * as panels from "../panel";
import { SaveConfig } from "../types/panels";

type PanelProps = {
  config: unknown;
  saveConfig: SaveConfig<unknown>;
};

export default function PanelCatalogProvider(
  props: PropsWithChildren<unknown>,
): React.ReactElement {
  const [showDebugPanels = false] = useAppConfigurationValue<boolean>(AppSetting.SHOW_DEBUG_PANELS);
  const [enableLegacyPlotPanel = false] = useAppConfigurationValue<boolean>(
    AppSetting.ENABLE_LEGACY_PLOT_PANEL,
  );
  const [enableNewImagePanel = false] = useAppConfigurationValue<boolean>(
    AppSetting.ENABLE_NEW_IMAGE_PANEL,
  );
  const { t } = useTranslation("panels");

  const extensionPanels = useExtensionCatalog((state) => state.installedPanels);

  const wrappedExtensionPanels = useMemo<PanelInfo[]>(() => {
    return Object.values(extensionPanels ?? {}).map((panel) => {
      const panelType = `${panel.extensionName}.${panel.registration.name}`;
      
      return {
        category: "misc",
        title: panel.registration.name,
        type: panelType,
        module: async () => ({ default: Panel(PanelWrapper) }),
        extensionNamespace: panel.extensionNamespace,
      };
    });
  }, [extensionPanels]);

  // Re-call the function when the language changes to ensure that the panel's information is successfully translated
  const allPanelsInfo = useMemo(() => {
    return {
      builtin: panels.getBuiltin(t),
      debug: panels.getDebug(t),
      legacyPlot: panels.getLegacyPlot(t),
      newImage: panels.getNewImage(t),
    };
  }, [t]);

  const allPanels = useMemo(() => {
    return [
      ...allPanelsInfo.builtin,
      ...allPanelsInfo.debug,
      allPanelsInfo.newImage,
      allPanelsInfo.legacyPlot,
      ...wrappedExtensionPanels,
    ];
  }, [wrappedExtensionPanels, allPanelsInfo]);

  const visiblePanels = useMemo(() => {
    const panelList = [...allPanelsInfo.builtin];
    if (showDebugPanels) {
      panelList.push(...allPanelsInfo.debug);
    }
    if (enableLegacyPlotPanel) {
      panelList.push(allPanelsInfo.legacyPlot);
    }
    if (enableNewImagePanel) {
      panelList.push(allPanelsInfo.newImage);
    }
    panelList.push(...wrappedExtensionPanels);
    return panelList;
  }, [
    enableLegacyPlotPanel,
    enableNewImagePanel,
    showDebugPanels,
    wrappedExtensionPanels,
    allPanelsInfo,
  ]);

  const panelsByType = useMemo(() => {
    const byType = new Map<string, PanelInfo>();

    for (const panel of allPanels) {
      const type = panel.type;
      byType.set(type, panel);
    }
    return byType;
  }, [allPanels]);

  const provider = useMemo<PanelCatalog>(() => {
    return {
      getPanels() {
        return visiblePanels;
      },
      getPanelByType(type: string) {
        return panelsByType.get(type);
      },
    };
  }, [panelsByType, visiblePanels]);

  return (
    <PanelCatalogContext.Provider value={provider}>{props.children}</PanelCatalogContext.Provider>
  );
}
