
import React, { useState, useEffect } from 'react';

import * as THREE from "three";
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader';

import { imgInfo } from '../../interface';
import "./index.scss";

import imgSrc from "../../static/pgm.png";
// const sceneGltf = require("./scene.gltf");

const PgmMap: React.FC = ( props ) => {

    useEffect( () => {

        let boxDom: HTMLElement = document.getElementById("pgm-box")!;
        // 创建渲染器
        const renderer = new THREE.WebGLRenderer({ canvas: boxDom });
        renderer.setSize( window.innerWidth, window.innerHeight );

        // 创建相机
        const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 1, 500 );
        camera.position.set(20, 10, 0);
        // camera.lookAt(20, 20, 20);

        // 创建辅助坐标系
        const axesHelper = new THREE.AxesHelper(5);

        // 创建轨道控制器
        const controls = new OrbitControls(camera, renderer.domElement);
        controls.minPolarAngle = .5;
        controls.maxPolarAngle = .8;
        controls.enableDamping = true;
        // controls.enableRotate = false;
        controls.enablePan = true;
        controls.enableZoom = true;
        
        controls.minAzimuthAngle = 0;
        controls.maxAzimuthAngle = 0;

        // controls.minDistance = 1;
        // controls.maxDistance = 2
        const width = 921/50;
        const height = 754/50;

        // 创建几何体
        const geometry = new THREE.BoxGeometry(width, height, .01);
        // geometry.translate(width / 2, height / 2,  0);

        // 创建纹理加载器
        const textureLoader = new THREE.TextureLoader();
        // 导入纹理贴图基础贴图
        const chungeLoader = textureLoader.load(imgSrc);

        // 创建材质对象
        const material = new THREE.MeshBasicMaterial({
            map: chungeLoader,
            depthWrite: false,
            transparent: true,
        });

        

        const cube = new THREE.Mesh(geometry, material);
        // 沿x旋转90°
        cube.rotation.x = Math.PI / 2;
        

        // 创建场景
        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x000000); // 设置场景背景颜色

        scene.add(axesHelper);
        scene.add(cube);

        let lights = [[2,3,0], [8,6,0]];
        lights.forEach((item, index) => {
            const light = new THREE.DirectionalLight(0xFFFFFF, 1);
            let [x, y, z] = item;
            light.position.set(x, y, z);
            scene.add(light);
        });

        // const loader = new GLTFLoader().setPath('../../static/gltf');
        const loader = new GLTFLoader();
        // loader.load( './glft1/robot/scene.gltf', function ( gltf ) {
        loader.load( './gltf/scene.gltf', function ( gltf ) {
            console.log(gltf);
            gltf.scene.scale.set(0.2, 0.2, 0.2);
            gltf.scene.position.set(2, .12, 2);
            gltf.scene.rotation.y = 180;
            (window as any).gltf = gltf;
            scene.add( gltf.scene );
            renderer.render( scene, camera );
        }, function() {
            console.log("正在导入 ...")
        }, function ( error ) {

            console.error( '导入失败 -> ', error );

        } );

        function animate() {
            controls.update();
            renderer.render( scene, camera );
            requestAnimationFrame( animate );
        };

        animate();
        // renderer.render( scene, camera );

    }, []);

    const getImgInfo = async ( src: string ): Promise<imgInfo> => {
        let result = await loadImg_W_H(src);
        console.log(result)
        return result
    }

    const loadImg_W_H = ( src: string ): Promise<imgInfo> => {
        console.log(src)
        return new Promise((resolve, reject) => {
            let imgObj = new Image();
            imgObj.src= imgSrc;
            imgObj.onload = () => {
                resolve({ width: imgObj.width, height: imgObj.height })
            }
        })
    };

    return <div className='pgm-demo1'>
        <canvas id='pgm-box'></canvas>
    </div>
};

export default PgmMap;