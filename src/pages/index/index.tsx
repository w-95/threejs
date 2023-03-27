
import React, { ReactElement, useEffect } from 'react';

import * as THREE from "three"

import "./index.scss";

let time: any =  1;

const ThreeDemo1: React.FC = ( props ) => {

    useEffect(() => {
        console.log(THREE)

        let boxDom:any = document.getElementById("demo1-box")!;

        // 创建渲染器
        const webGLRender = new THREE.WebGLRenderer({antialias: true, canvas: boxDom});

        // 创建场景
        const scene = new THREE.Scene()

        // 创建相机 透视摄像机
        const camera = new THREE.PerspectiveCamera(75, boxDom.width / boxDom.height, .1, 500);
        camera.aspect = boxDom.clientWidth / boxDom.clientHeight;
        camera.updateProjectionMatrix();
        camera.position.z = 5;

        // 创建立方体
        const geometry = new THREE.BoxGeometry(1, 1, 1); 

        // 设置立方体受灯光影响的材质
        // const material = new THREE.MeshPhongMaterial({ color: 0x44aa88, emissive: '', fog: true, specular: 'red' });
        // const material = new THREE.MeshBasicMaterial({ color: 0x44aa88});

        // 添加网格
        // const cube = new THREE.Mesh(geometry, material);
        // scene.add( cube );

        const makeInstance = (geometry: THREE.BufferGeometry, colorOptions: THREE.MeshPhongMaterialParameters, x: number) => {
            // 创建受灯光影响的材质
            const material = new THREE.MeshPhongMaterial({...colorOptions});
     
            const cube = new THREE.Mesh(geometry, material);
            scene.add(cube);
           
            cube.position.x = x;
           
            return cube;
        };

        const cubes = [
            makeInstance(geometry, { color: 0x8844aa, emissive: '', fog: true, specular: 'green' }, -2),
            makeInstance(geometry, { color: 0x44aa88, emissive: '', fog: true, specular: 'red' },  0),
            makeInstance(geometry, { color: 0xaa8844, emissive: '', fog: true, specular: 'pink' },  2),
        ];

        // 创建平行光灯光
        const light = new THREE.DirectionalLight(0xFFFFFF, 1);
        light.position.set(-1, 2, 4);
        scene.add(light);

        webGLRender.setSize( boxDom.clientWidth, boxDom.clientHeight );

        const animate = () => {
            requestAnimationFrame( animate );
            // cube.rotation.x += 0.01;
            // cube.rotation.y += 0.01;
            // webGLRender.render( scene, camera );
 
            cubes.forEach((cube, ndx) => {
                cube.rotation.x += 0.01;
                cube.rotation.y += 0.01;
                
            });
            webGLRender.render( scene, camera );
        };

        // 渲染
        animate();
    }, []);

    return <div className='three-demo1'>
        <canvas id='demo1-box'></canvas>
    </div>
};

export default ThreeDemo1;