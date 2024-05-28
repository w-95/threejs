// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import * as THREE from "three";

import type { IRenderer } from "../IRenderer";
import { arrowHeadSubdivisions, arrowShaftSubdivisions, DetailLevel } from "../lod";
import { ColorRGBA } from "../ros";
//import { start } from "@popperjs/core";

const SHAFT_LENGTH = 0.154;
const SHAFT_DIAMETER = 0.02;
const HEAD_LENGTH = 0.046;
const HEAD_DIAMETER = 0.05;

export const AXIS_LENGTH = SHAFT_LENGTH + HEAD_LENGTH;

const RED_COLOR = new THREE.Color(0x9c3948).convertSRGBToLinear();
const GREEN_COLOR = new THREE.Color(0x88dd04).convertSRGBToLinear();
const BLUE_COLOR = new THREE.Color(0x2b90fb).convertSRGBToLinear();

const COLOR_WHITE = { r: 1, g: 1, b: 1, a: 1 };

const PI_2 = Math.PI / 2;

const tempMat4 = new THREE.Matrix4();
const tempVec = new THREE.Vector3();

//zwd4
//START_MARK:开始图标,END_MARK结束图标,NORMAL_MARK普通点位图标,CHARGE_MARK充电位图标
export enum MARK_TYPE { START_MARK,END_MARK,NORMAL_MARK,CHARGE_MARK }

export class AxisMark extends THREE.Object3D {
  private readonly renderer: IRenderer;
  private shaftMesh: THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  private headMesh: THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;

  //zwd4
  //markType：图标类型
  //rotateX：图标是否旋转90度
  public constructor(name: string, renderer: IRenderer,markType:MARK_TYPE,rotateX:boolean) {
    super();
    this.name = name;
    this.renderer = renderer;

    // Create three arrow shafts
    const shaftGeometry = this.renderer.sharedGeometry.getGeometry(
      `${this.constructor.name}-shaft-${this.renderer.maxLod}`,
      () => createShaftGeometry(this.renderer.maxLod),
    );
    this.shaftMesh = new THREE.InstancedMesh(shaftGeometry, standardMaterial(COLOR_WHITE), 3);
    this.shaftMesh.castShadow = true;
    this.shaftMesh.receiveShadow = true;

    // Create three arrow heads
    const headGeometry = this.renderer.sharedGeometry.getGeometry(
      `${this.constructor.name}-head-${this.renderer.maxLod}`,
      () => createHeadGeometry(this.renderer.maxLod),
    );

    this.headMesh = new THREE.InstancedMesh(headGeometry, standardMaterial(COLOR_WHITE), 3);
    this.headMesh.castShadow = true;
    this.headMesh.receiveShadow = true;

    AxisMark.UpdateInstances(this.shaftMesh, this.headMesh, 0);

    //zwd4绘制，下面是新的箭头程序
    if(markType==MARK_TYPE.START_MARK)
    {
      var scale=0.11
      var cylinderHeight=0.04
      var cylinderOuter = new THREE.CylinderGeometry(
        1.1*scale, //radiusTop
        1.1*scale,//radiusBottom
        cylinderHeight,//height
        32,//radialSegment放射状分段数量
      );
      var cylinderOuterMesh = new THREE.Mesh(cylinderOuter, new THREE.MeshStandardMaterial({ color: 0xFFFFFF}));
      //圆柱面方向默认是Y方向
      //绕X轴逆时针旋转90度
      cylinderOuterMesh.rotateX(Math.PI /2);
      cylinderOuterMesh.name = 'Cylinder';
      this.add(cylinderOuterMesh)

      var cylinderInner = new THREE.CylinderGeometry(
        1*scale, //radiusTop
        1*scale,//radiusBottom
        cylinderHeight+0.01,//height，+0.02表示突出一点，否则cylinderInner的颜色要与cylinder的颜色混在一起
        32,//radialSegment放射状分段数量
      );
      var cylinderInnerMesh = new THREE.Mesh(cylinderInner,new THREE.MeshBasicMaterial({color: 0x0000ff}));
      //圆柱面方向默认是Y方向
      //绕X轴逆时针旋转90度
      cylinderInnerMesh.rotateX(Math.PI /2); 
      cylinderInnerMesh.name = 'Cylinder';
      this.add(cylinderInnerMesh)
      //三角形-二维
      const triangleShape = new THREE.Shape();
      triangleShape.moveTo(0.8*scale, 0*scale);
      triangleShape.lineTo(-0.5*scale, 0.5*scale);
      triangleShape.lineTo(-0.2*scale, 0*scale);
      triangleShape.lineTo(-0.5*scale, -0.5*scale);
      triangleShape.lineTo(0.8*scale, 0*scale);
      //三角形-三维
      var triangleHeight=cylinderHeight+0.2*scale
      const extrudeSettings = {
        amount:1,
        steps: 1,
        depth: triangleHeight,
        bevelSize:0.1,
        bevelThickness:0.1,
        bevelSegments:2,
        bevelEnabled:false,
      }
      const triangleGeometry = new THREE.ExtrudeGeometry(triangleShape, extrudeSettings)
      //const material = new THREE.MeshPhongMaterial({ color: 0xFFff00, side: THREE.DoubleSide })
      const triangleMesh = new THREE.Mesh(triangleGeometry, new THREE.MeshStandardMaterial({ color: 0xFFFFFF}))
      triangleMesh.translateZ(-triangleHeight/2.0);
      triangleMesh.name='triangle';
      this.add(triangleMesh)
    }
    else
    {
      // 创建二维心形路径
      var scale2=0.1
      const outterR=1.0;
      const heartH=2.0;
      const innerR=0.5
      const heartShape = new THREE.Shape()
      heartShape.arc ( 0,0, outterR*scale2, 0, Math.PI, false );
      heartShape.lineTo(0, -heartH*scale2)
      heartShape.lineTo(outterR*scale2, 0)

      //内圆
      if(markType!=MARK_TYPE.CHARGE_MARK)
      {
        const shape_c1 = new THREE.Path()
        shape_c1.ellipse(0,0,innerR*scale2,innerR*scale2,0,Math.PI*2,true,0)
        heartShape.holes.push(shape_c1)
      }
      else
      {
        //内部闪电
        const shape_c2 = new THREE.Path()
        shape_c2.moveTo(-0.3*scale2,0.5*scale2) //左上角
        shape_c2.lineTo(0.3*scale2,0.5*scale2) //右上角
        shape_c2.lineTo(0.1*scale2,0.1*scale2)
        shape_c2.lineTo(0.3*scale2,-0.1*scale2)
        shape_c2.lineTo(-0.05*scale2,-0.9*scale2) //最下面的点
        shape_c2.lineTo(0*scale2,-0.3*scale2)
        shape_c2.lineTo(-0.3*scale2,0*scale2)
        shape_c2.lineTo(-0.3*scale2,0.5*scale2)
        heartShape.holes.push(shape_c2)
      }
      const extrudeSettings2 = {
      amount:1,
      steps: 1,
      depth: 0.04,
      bevelSize:0.1,
      bevelThickness:0.1,
      bevelSegments:2,
      bevelEnabled:false,
      }
      const heartGeometry = new THREE.ExtrudeGeometry(heartShape, extrudeSettings2)
      var bkColor;
      if (markType==MARK_TYPE.END_MARK)
        bkColor=0xDD3300;
      else if (markType==MARK_TYPE.CHARGE_MARK)
        bkColor=0x2DCC6D;     //2DCC6D   00FF00
      else
        bkColor=0xF7AD2C;     //F7AD2C   FFEE00
      //const heartMaterial = new THREE.MeshPhongMaterial({ color: 0xFFff00, side: THREE.DoubleSide })
      const heartMesh = new THREE.Mesh(heartGeometry, new THREE.MeshStandardMaterial({ color: bkColor}))//终点颜色
      //heartMesh.translateZ(-triangleHeight/2.0);
      heartMesh.name='heart'; 
      if(rotateX)
      {//绕X轴逆时针旋转90度
        heartMesh.rotateX(Math.PI /2);
      }     
      this.add(heartMesh)
    }

    //zwd4注释 下面是原有代码的箭头绘制程序
    // this.add(this.shaftMesh);
    // this.add(this.headMesh);
  }

  public dispose(): void {
    this.shaftMesh.material.dispose();
    this.shaftMesh.dispose();
    this.headMesh.material.dispose();
    this.headMesh.dispose();
  }

  private static UpdateInstances(
    shaft: THREE.InstancedMesh,
    head: THREE.InstancedMesh,
    axisIndex: number,
  ): void {
    const indexX = axisIndex * 3 + 0;
    const indexY = axisIndex * 3 + 1;
    const indexZ = axisIndex * 3 + 2;

    // Set x, y, and z axis arrow shaft directions
    tempVec.set(SHAFT_LENGTH, SHAFT_DIAMETER, SHAFT_DIAMETER);
    shaft.setMatrixAt(indexX, tempMat4.identity().scale(tempVec));
    shaft.setMatrixAt(indexY, tempMat4.makeRotationZ(PI_2).scale(tempVec));
    shaft.setMatrixAt(indexZ, tempMat4.makeRotationY(-PI_2).scale(tempVec));

    // Set x, y, and z axis arrow head directions
    tempVec.set(HEAD_LENGTH, HEAD_DIAMETER, HEAD_DIAMETER);
    tempMat4.identity().scale(tempVec).setPosition(SHAFT_LENGTH, 0, 0);
    head.setMatrixAt(indexX, tempMat4);
    tempMat4.makeRotationZ(PI_2).scale(tempVec).setPosition(0, SHAFT_LENGTH, 0);
    head.setMatrixAt(indexY, tempMat4);
    tempMat4.makeRotationY(-PI_2).scale(tempVec).setPosition(0, 0, SHAFT_LENGTH);
    head.setMatrixAt(indexZ, tempMat4);

    // Set x, y, and z axis arrow shaft colors
    shaft.setColorAt(indexX, RED_COLOR);
    shaft.setColorAt(indexY, GREEN_COLOR);
    shaft.setColorAt(indexZ, BLUE_COLOR);

    // Set x, y, and z axis arrow head colors
    head.setColorAt(indexX, RED_COLOR);
    head.setColorAt(indexY, GREEN_COLOR);
    head.setColorAt(indexZ, BLUE_COLOR);
  }
}

function createShaftGeometry(lod: DetailLevel): THREE.CylinderGeometry {
  const subdivs = arrowShaftSubdivisions(lod);
  const shaftGeometry = new THREE.CylinderGeometry(0.5, 0.5, 1, subdivs, 1, false);
  shaftGeometry.rotateZ(-PI_2);
  shaftGeometry.translate(0.5, 0, 0);
  shaftGeometry.computeBoundingSphere();
  return shaftGeometry;
}
function createHeadGeometry(lod: DetailLevel): THREE.ConeGeometry {
  const subdivs = arrowHeadSubdivisions(lod);
  const headGeometry = new THREE.ConeGeometry(0.5, 1, subdivs, 1, false);
  headGeometry.rotateZ(-PI_2);
  headGeometry.translate(0.5, 0, 0);
  headGeometry.computeBoundingSphere();
  return headGeometry;
}
function standardMaterial(color: ColorRGBA): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(color.r, color.g, color.b).convertSRGBToLinear(),
    metalness: 0,
    roughness: 1,
    dithering: true,
    opacity: color.a,
    transparent: color.a < 1,
    depthWrite: color.a === 1,
  });
}
