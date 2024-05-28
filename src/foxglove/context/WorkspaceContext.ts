// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { createContext, Dispatch, SetStateAction, useMemo, useState } from "react";
import { DeepReadonly } from "ts-essentials";
import { StoreApi, useStore } from "zustand";

import { useCurrentUser } from "../context/CurrentUserContext";
import { useAppConfigurationValue } from "../hooks/useAppConfigurationValue";
import useGuaranteedContext from "../context/useGuaranteedContext";

function isDesktopApp(): boolean {
  return Boolean((global as unknown as { desktopBridge: unknown }).desktopBridge);
};

export type AppSettingsTab = 
| "general"
| "privacy"
| "extensions"
| "experimental-features"
| "about";

export type SidebarItemKey =
  | "account"
  | "add-panel"
  | "connection"
  | "extensions"
  | "help"
  | "layouts"
  | "panel-settings"
  | "app-settings"
  | "studio-logs-settings"
  | "variables";

const LeftSidebarItemKeys = ["panel-settings", "topics"] as const;
export type LeftSidebarItemKey = (typeof LeftSidebarItemKeys)[number];

const RightSidebarItemKeys = ["events", "variables", "studio-logs-settings"] as const;
export type RightSidebarItemKey = (typeof RightSidebarItemKeys)[number];

export type WorkspaceContextStore = DeepReadonly<{
  leftSidebarOpen: boolean;
  rightSidebarOpen: boolean;
  leftSidebarItem: undefined | LeftSidebarItemKey;
  leftSidebarSize: undefined | number;
  rightSidebarItem: undefined | RightSidebarItemKey;
  rightSidebarSize: undefined | number;
  prefsDialogState: {
    initialTab: undefined | AppSettingsTab;
    open: boolean;
  };
  // 面板设置弹出框状态 2023-05-02 yxd
  prefsPanelSettingDialogState: {
    open: boolean;
  };
  sidebarItem: undefined | SidebarItemKey;
}>;

export const WorkspaceContext = createContext<undefined | StoreApi<WorkspaceContextStore>>(
  undefined,
);

WorkspaceContext.displayName = "WorkspaceContext";

export const WorkspaceStoreSelectors = {
  selectPanelSettingsOpen: (store: WorkspaceContextStore): boolean => {
    return (
      store.sidebarItem === "panel-settings" ||
      (store.leftSidebarOpen && store.leftSidebarItem === "panel-settings")
    );
  },
};

/**
 * Fetches values from the workspace store.
 */
export function useWorkspaceStore<T>(
  selector: (store: WorkspaceContextStore) => T,
  equalityFn?: (a: T, b: T) => boolean,
): T {
  const context = useGuaranteedContext(WorkspaceContext);
  return useStore(context, selector, equalityFn);
}

export type WorkspaceActions = {
  openAccountSettings: () => void;
  openPanelSettings: () => void;
  open3DPanelSettings: () => void; //打开“选择需要展示的数据”  2023-05-03  yxd
  openLayoutBrowser: () => void;
  prefsDialogActions: {
    close: () => void;
    open: (initialTab?: AppSettingsTab) => void;
  };
  // 面板设置弹出框事件 2023-05-02 yxd
  prefsPanelSettingDialogActions: {
    close: () => void;
  };
  selectSidebarItem: (selectedSidebarItem: undefined | SidebarItemKey) => void;
  selectLeftSidebarItem: (item: undefined | LeftSidebarItemKey) => void;
  selectRightSidebarItem: (item: undefined | RightSidebarItemKey) => void;
  setLeftSidebarOpen: Dispatch<SetStateAction<boolean>>;
  setLeftSidebarSize: (size: undefined | number) => void;
  setRightSidebarOpen: Dispatch<SetStateAction<boolean>>;
  setRightSidebarSize: (size: undefined | number) => void;
};

function setterValue<T>(action: SetStateAction<T>, value: T): T {
  if (action instanceof Function) {
    return action(value);
  }

  return action;
}

/**
 * Provides various actions to manipulate the workspace state.
 */
export function useWorkspaceActions(): WorkspaceActions {
  const { setState: set } = useGuaranteedContext(WorkspaceContext);

  const { signIn } = useCurrentUser();
  const supportsAccountSettings = signIn != undefined;

  const [currentEnableNewTopNav = false] = useAppConfigurationValue<boolean>('enableNewTopNav');
  const [initialEnableNewTopNav] = useState(currentEnableNewTopNav);
  const enableNewTopNav = isDesktopApp() ? initialEnableNewTopNav : currentEnableNewTopNav;

  return useMemo(() => {
    return {
      openAccountSettings: () => supportsAccountSettings && set({ sidebarItem: "account" }),

      openPanelSettings: () =>
        enableNewTopNav
          ? set({ leftSidebarItem: "panel-settings", leftSidebarOpen: true })
           : set({ sidebarItem: "panel-settings" }),
      
      //打开“选择需要展示的数据”  2023-05-03  yxd
      open3DPanelSettings: () =>
          set({prefsPanelSettingDialogState:{open:true}}),

      openLayoutBrowser: () => set({ sidebarItem: "layouts" }),

      prefsDialogActions: {
        close: () => set({ prefsDialogState: { open: false, initialTab: undefined } }),
        open: (initialTab?: AppSettingsTab) => {
          set({ prefsDialogState: { open: true, initialTab } });
        },
      },
      // 面板设置弹出框事件 2023-05-02 yxd
      prefsPanelSettingDialogActions:{
        close: () => set({ prefsPanelSettingDialogState: { open: false } }),
        open: () => {set({ prefsPanelSettingDialogState: { open: true} });
        },
      },

      selectSidebarItem: (selectedSidebarItem: undefined | SidebarItemKey) => {
        if (selectedSidebarItem === "app-settings") {
          set({ prefsDialogState: { open: true, initialTab: undefined } });
        } else {
          set({ sidebarItem: selectedSidebarItem });
        }
      },

      selectLeftSidebarItem: (selectedLeftSidebarItem: undefined | LeftSidebarItemKey) => {
        set({
          leftSidebarItem: selectedLeftSidebarItem,
          leftSidebarOpen: selectedLeftSidebarItem != undefined,
        });
      },

      selectRightSidebarItem: (selectedRightSidebarItem: undefined | RightSidebarItemKey) => {
        set({
          rightSidebarItem: selectedRightSidebarItem,
          rightSidebarOpen: selectedRightSidebarItem != undefined,
        });
      },

      setLeftSidebarOpen: (setter: SetStateAction<boolean>) => {
        set((oldValue) => {
          const leftSidebarOpen = setterValue(setter, oldValue.leftSidebarOpen);
          if (leftSidebarOpen) {
            const oldItem = LeftSidebarItemKeys.find((item) => item === oldValue.leftSidebarItem);
            return {
              leftSidebarOpen,
              leftSidebarItem: oldItem ?? "panel-settings",
            };
          } else {
            return { leftSidebarOpen: false };
          }
        });
      },

      setLeftSidebarSize: (leftSidebarSize: undefined | number) => set({ leftSidebarSize }),

      setRightSidebarOpen: (setter: SetStateAction<boolean>) => {
        set((oldValue) => {
          const rightSidebarOpen = setterValue(setter, oldValue.rightSidebarOpen);
          const oldItem = RightSidebarItemKeys.find((item) => item === oldValue.rightSidebarItem);
          if (rightSidebarOpen) {
            return {
              rightSidebarOpen,
              rightSidebarItem: oldItem ?? "variables",
            };
          } else {
            return { rightSidebarOpen: false };
          }
        });
      },

      setRightSidebarSize: (rightSidebarSize: undefined | number) => set({ rightSidebarSize }),
    };
  }, [enableNewTopNav, set, supportsAccountSettings]);
}
