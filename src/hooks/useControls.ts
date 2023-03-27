import React, { useEffect, useState} from "react";
import * as THREE from "three";
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';

// 创建控制器 限制控制器推拽范围
export const useControls = () => {
    const [controls, setControls] = useState<any>();
    const [isDragging, setIsDragging] = useState(false);
    const [deltaMove, setDeltaMove] = useState({ x: 0, y: 0});

    const onEvent = ( camera: THREE.Camera, renderer: THREE.WebGLRenderer ) => {

        let controls1 = new OrbitControls(camera, renderer.domElement);
        controls1.enableDamping = true;
        setControls(new OrbitControls(camera, renderer.domElement));
        

        let previousMousePosition = { x: 0, y: 0 };

        document.addEventListener('mousedown', (event) => {
            setIsDragging(true);
        });

        document.addEventListener('mousemove', (event) => {
            if(isDragging) {
                setDeltaMove({
                    x: event.offsetX - previousMousePosition.x,
                    y: event.offsetY - previousMousePosition.y,
                });

                // 根据鼠标移动的距离更新相机位置
                let deltaRotationQuaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(
                    deltaMove.y * Math.PI / 180,
                    deltaMove.x  * Math.PI / 180,
                    0,
                    'XYZ'
                ));

                camera.quaternion.multiplyQuaternions(deltaRotationQuaternion, camera.quaternion);
                camera.position.add(new THREE.Vector3(deltaMove.x, deltaMove.y, 0));

                // 检查相机的位置是否超过y轴的负数
                if(camera.position.y < 0) {
                    camera.position.setY(0);
                };

                previousMousePosition = {
                    x: event.offsetX,
                    y: event.offsetY
                };
            };
        });

        document.addEventListener('mouseup', (event) => {
            setIsDragging(false)
        })
    }

    return { controls, setControls, onEvent }
}