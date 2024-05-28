import React from "react";
import ThreeDemo1 from "./pages/index";
import ThreePgm from "./pages/pgmMap/index";
import Ros3d from "./pages/ros3d/index";

const routerConfig = [{
    path: '/',
    element: <ThreeDemo1 />
},{
    path: '/map',
    element: <ThreePgm />
},];

export default routerConfig;