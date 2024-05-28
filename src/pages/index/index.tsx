import React, { useEffect, useMemo, useState } from 'react';
import { useLatest, useMountedState } from "react-use";
import Player from "../../foxglove/player/player";
import { useAnalytics } from "../../foxglove/context/AnalyticsContext";
import AnalyticsMetricsCollector from "../../foxglove/AnalyticsMetricsCollector";

import {useCurrentLayoutSelector, LayoutState} from "../../foxglove/context/CurrentLayoutContext";

import { GlobalVariables } from "../../foxglove/types/types";
import useShallowMemo from "../../foxglove/hooks/useShallowMemo";
import { useUserNodeState } from "../../foxglove/context/UserNodeStateContext";
import UserNodePlayer from "../../foxglove/player/UserNodePlayer";
import "./index.scss";

const sourceId = 'foxglove-websocket';
const rosNumber = "ARX13012104B003";

const EMPTY_GLOBAL_VARIABLES: GlobalVariables = Object.freeze({});

const globalVariablesSelector = (state: LayoutState) => state.selectedLayout?.data?.globalVariables ?? EMPTY_GLOBAL_VARIABLES;
const ThreeDemo1: React.FC = ( props ) => {

    const analytics = useAnalytics();
    const [basePlayer, setBasePlayer] = useState<Player | undefined>();

    const globalVariables = useCurrentLayoutSelector(globalVariablesSelector);
    const { setUserNodeDiagnostics, addUserNodeLogs, setUserNodeRosLib, setUserNodeTypesLib } = useUserNodeState();
    const userNodeActions = useShallowMemo({
        setUserNodeDiagnostics,
        addUserNodeLogs,
        setUserNodeRosLib,
        setUserNodeTypesLib,
    });
    const globalVariablesRef = useLatest(globalVariables);

    const player = useMemo(() => {
        if (!basePlayer) {
            return undefined;
        }
        const userNodePlayer = new UserNodePlayer(basePlayer, userNodeActions);
        userNodePlayer.setGlobalVariables(globalVariablesRef.current);
        return userNodePlayer;
    }, [basePlayer, globalVariablesRef, userNodeActions]);

    const metricsCollector = useMemo(() => new AnalyticsMetricsCollector(analytics), [analytics]);

    useEffect(() => {
        //{ type: "connection", params: { url: url}
        const url = "ws://localhost:8765?rosNumber=" + rosNumber;
        metricsCollector.setProperty("player", sourceId);
        const newPlayer = new Player({
            url: url,
            metricsCollector,
            sourceId,
            rosNumber
        });

        setBasePlayer(newPlayer);

        console.log(newPlayer, "this is a newPlayer Class.");
    }, []);

    return <div className='three-demo1' id='map'></div>
};

export default ThreeDemo1;