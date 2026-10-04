import * as THREE from 'three';
import type { CameraMode, FlightState } from './types';
import { buildCity } from './city';
import { FLIGHT_MAPS, type FlightMap } from './maps';

const COLORS = {
  grass: '#a9b28f',
  path: '#c9bf9b',
  charcoal: '#303b38',
  orange: '#e88850',
  cream: '#f3ebd6',
};

function randomGenerator(seed: number): () => number {
  let value = seed;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

function canvasTexture(width: number, height: number, paint: (context: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser could not create the flight scene textures.');
  paint(context);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function standardMaterial(color: THREE.ColorRepresentation, options: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.88, metalness: 0.02, ...options });
}

function box(parent: THREE.Object3D, dimensions: [number, number, number], position: [number, number, number], material: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...dimensions), material);
  mesh.position.set(...position);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function cylinderBetween(parent: THREE.Object3D, start: THREE.Vector3, end: THREE.Vector3, radius: number, material: THREE.Material, segments = 8): THREE.Mesh {
  const direction = new THREE.Vector3().subVectors(end, start);
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, direction.length(), segments), material);
  mesh.position.copy(start).add(end).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  mesh.castShadow = true;
  parent.add(mesh);
  return mesh;
}

export class FlightScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(57, 1, 0.06, 1300);
  private readonly observer: ResizeObserver;
  private readonly drone = new THREE.Group();
  private readonly body = new THREE.Group();
  private readonly propellers: THREE.Group[] = [];
  private readonly gateAccents: THREE.MeshStandardMaterial[] = [];
  private readonly gateHalos: THREE.Mesh[] = [];
  private readonly cameraPosition = new THREE.Vector3();
  private readonly cameraTarget = new THREE.Vector3();
  private readonly desiredPosition = new THREE.Vector3();
  private readonly desiredTarget = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private readonly cameraOrientation = new THREE.Quaternion();
  private readonly buildingBounds: THREE.Box3[] = [];
  private readonly cameraRay = new THREE.Ray();
  private readonly cameraHit = new THREE.Vector3();
  private readonly shadow: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly windsock = new THREE.Group();
  private readonly statusLights: THREE.MeshStandardMaterial;
  private cameraNeedsReset = true;
  private previousCameraMode: CameraMode = 'chase';
  private previousActiveGate = -1;
  private elapsed = 0;
  private disposed = false;

  constructor(container: HTMLElement, private readonly flightMap: FlightMap = FLIGHT_MAPS['pine-valley']) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.setAttribute('aria-label', `Three-dimensional ${flightMap.name} drone flight map`);
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    container.appendChild(this.renderer.domElement);
    const city = flightMap.id === 'nyc';
    this.scene.background = new THREE.Color(city ? '#d1dfdf' : '#cddbd8');
    this.scene.fog = new THREE.Fog(city ? '#d5dedc' : '#cbd6ca', city ? 180 : 130, city ? 760 : 570);

    this.buildLighting();
    this.buildSky();
    if (city) {
      buildCity(this.scene, flightMap);
      for (const building of flightMap.buildings) {
        for (const tier of building.tiers) {
          this.buildingBounds.push(new THREE.Box3(
            new THREE.Vector3(building.x - tier.width / 2 - 0.3, tier.base - 0.3, building.z - tier.depth / 2 - 0.3),
            new THREE.Vector3(building.x + tier.width / 2 + 0.3, tier.base + tier.height + 0.3, building.z + tier.depth / 2 + 0.3),
          ));
        }
      }
    } else {
      this.buildTerrain();
      this.buildMountains();
      this.buildTrees();
      this.buildScenery();
    }
    this.buildCourse();
    this.statusLights = standardMaterial('#92c4ad', { emissive: '#72c9a5', emissiveIntensity: 0.5 });
    this.buildDrone();

    const shadowTexture = canvasTexture(128, 128, (context) => {
      const gradient = context.createRadialGradient(64, 64, 3, 64, 64, 64);
      gradient.addColorStop(0, 'rgba(35, 43, 31, 0.38)');
      gradient.addColorStop(0.35, 'rgba(35, 43, 31, 0.2)');
      gradient.addColorStop(1, 'rgba(35, 43, 31, 0)');
      context.fillStyle = gradient;
      context.fillRect(0, 0, 128, 128);
    });
    this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(2.7, 2.7), new THREE.MeshBasicMaterial({ map: shadowTexture, transparent: true, depthWrite: false, opacity: 0.8 }));
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.position.y = 0.047;
    this.scene.add(this.shadow);

    const resize = () => {
      if (this.disposed) return;
      const width = Math.max(container.clientWidth, 1);
      const height = Math.max(container.clientHeight, 1);
      this.renderer.setSize(width, height, false);
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
    };
    this.observer = new ResizeObserver(resize);
    this.observer.observe(container);
    resize();
  }

  private buildLighting(): void {
    const city = this.flightMap.id === 'nyc';
    this.scene.add(new THREE.HemisphereLight(city ? '#e2f1ff' : '#ecf4ee', city ? '#a5a298' : '#78825e', city ? 3.2 : 2.5));
    const sun = new THREE.DirectionalLight('#fff2d6', 3.25);
    sun.position.set(city ? -140 : -55, city ? 430 : 90, city ? 130 : 35);
    sun.target.position.set(0, 0, -35);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = city ? -310 : -105;
    sun.shadow.camera.right = city ? 310 : 105;
    sun.shadow.camera.top = city ? 310 : 105;
    sun.shadow.camera.bottom = city ? -310 : -105;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = city ? 900 : 240;
    sun.shadow.normalBias = 0.035;
    sun.shadow.bias = -0.00015;
    this.scene.add(sun, sun.target);
  }

  private buildSky(): void {
    const city = this.flightMap.id === 'nyc';
    const texture = canvasTexture(16, 256, (context) => {
      const gradient = context.createLinearGradient(0, 0, 0, 256);
      gradient.addColorStop(0, city ? '#6daaca' : '#86b3cb');
      gradient.addColorStop(0.38, city ? '#accfde' : '#bed3d9');
      gradient.addColorStop(0.52, city ? '#e6e7da' : '#e5e7d9');
      gradient.addColorStop(1, city ? '#d1d4c5' : '#d9dfc9');
      context.fillStyle = gradient;
      context.fillRect(0, 0, 16, 256);
    });
    const sky = new THREE.Mesh(new THREE.SphereGeometry(950, 32, 24), new THREE.MeshBasicMaterial({ map: texture, side: THREE.BackSide, fog: false, depthWrite: false }));
    this.scene.add(sky);
    const cloudMaterial = new THREE.MeshBasicMaterial({ color: '#edf0e4', transparent: true, opacity: 0.32, depthWrite: false, fog: false });
    const cloudGeometry = new THREE.SphereGeometry(1, 16, 8);
    const cloudPositions = [[-170, 110, -370, 60, 8, 16], [65, 135, -410, 90, 7, 20], [270, 128, -360, 56, 6, 18]];
    for (const [horizontal, altitude, depth, width, height, length] of cloudPositions) {
      const cloud = new THREE.Mesh(cloudGeometry, cloudMaterial);
      cloud.position.set(horizontal, altitude + (city ? 240 : 0), depth);
      cloud.scale.set(width, height, length);
      this.scene.add(cloud);
    }
  }

  private buildTerrain(): void {
    const random = randomGenerator(9301);
    const groundTexture = canvasTexture(512, 512, (context) => {
      context.fillStyle = '#aeb697';
      context.fillRect(0, 0, 512, 512);
      for (let index = 0; index < 14000; index += 1) {
        context.fillStyle = random() > 0.45 ? 'rgba(71, 90, 56, 0.045)' : 'rgba(231, 221, 179, 0.1)';
        const size = 1 + random() * 5;
        context.fillRect(random() * 512, random() * 512, size, size);
      }
      for (let index = 0; index < 30; index += 1) {
        context.fillStyle = 'rgba(149, 160, 124, 0.09)';
        context.beginPath();
        context.ellipse(random() * 512, random() * 512, 12 + random() * 60, 7 + random() * 22, random() * Math.PI, 0, Math.PI * 2);
        context.fill();
      }
    });
    groundTexture.wrapS = groundTexture.wrapT = THREE.RepeatWrapping;
    groundTexture.repeat.set(55, 55);
    groundTexture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(1600, 1600), standardMaterial('#ffffff', { map: groundTexture }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    const pathGeometry = new THREE.BufferGeometry();
    const positions: number[] = [];
    const pathSections = 24;
    for (let index = 0; index < pathSections; index += 1) {
      const firstDepth = 15 - index * 3.5;
      const secondDepth = firstDepth - 3.5;
      const firstWidth = 4.9 + Math.sin(index * 0.7) * 0.22;
      const secondWidth = 4.9 + Math.sin((index + 1) * 0.7) * 0.22;
      positions.push(-firstWidth, 0.013, firstDepth, firstWidth, 0.013, firstDepth, -secondWidth, 0.013, secondDepth);
      positions.push(firstWidth, 0.013, firstDepth, secondWidth, 0.013, secondDepth, -secondWidth, 0.013, secondDepth);
    }
    pathGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    pathGeometry.computeVertexNormals();
    const path = new THREE.Mesh(pathGeometry, standardMaterial(COLORS.path, { side: THREE.DoubleSide }));
    path.receiveShadow = true;
    this.scene.add(path);

    const edgeMaterial = standardMaterial('#d9d0b1');
    for (const horizontal of [-4.65, 4.65]) {
      const edge = new THREE.Mesh(new THREE.PlaneGeometry(0.055, 73), edgeMaterial);
      edge.rotation.x = -Math.PI / 2;
      edge.position.set(horizontal, 0.021, -25);
      this.scene.add(edge);
    }
    const stripeMaterial = standardMaterial('#e8dfc4');
    for (let depth = -7; depth > -68; depth -= 5) {
      const stripe = new THREE.Mesh(new THREE.PlaneGeometry(0.17, 1.5), stripeMaterial);
      stripe.rotation.x = -Math.PI / 2;
      stripe.position.set(0, 0.024, depth);
      this.scene.add(stripe);
    }

    const padTexture = canvasTexture(768, 768, (context) => {
      context.clearRect(0, 0, 768, 768);
      context.fillStyle = '#ddd9c4';
      context.beginPath();
      context.arc(384, 384, 382, 0, Math.PI * 2);
      context.fill();
      context.strokeStyle = '#b8b7a3';
      context.lineWidth = 4;
      context.beginPath();
      context.arc(384, 384, 370, 0, Math.PI * 2);
      context.stroke();
      context.strokeStyle = '#d78350';
      context.lineWidth = 12;
      context.beginPath();
      context.arc(384, 384, 328, 0, Math.PI * 2);
      context.stroke();
      context.strokeStyle = '#f7f3df';
      context.lineWidth = 3;
      context.beginPath();
      context.arc(384, 384, 308, 0, Math.PI * 2);
      context.stroke();
      context.fillStyle = '#737e6b';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.font = '500 280px Arial';
      context.fillText('H', 384, 405);
      context.font = '600 23px Arial';
      context.fillText('HOME  /  01', 384, 188);
      context.fillStyle = '#d78350';
      context.beginPath();
      context.moveTo(384, 47);
      context.lineTo(365, 87);
      context.lineTo(403, 87);
      context.closePath();
      context.fill();
      for (let index = 0; index < 8; index += 1) {
        context.save();
        context.translate(384, 384);
        context.rotate(index * Math.PI / 4);
        context.fillStyle = '#f3edd8';
        context.fillRect(-3, 337, 6, 15);
        context.restore();
      }
    });
    const pad = new THREE.Mesh(new THREE.CircleGeometry(3.5, 96), standardMaterial('#ffffff', { map: padTexture }));
    pad.rotation.x = -Math.PI / 2;
    pad.position.y = 0.036;
    pad.receiveShadow = true;
    this.scene.add(pad);

    const grassGeometry = new THREE.ConeGeometry(0.14, 0.55, 3);
    grassGeometry.translate(0, 0.24, 0);
    const grasses = new THREE.InstancedMesh(grassGeometry, standardMaterial('#89976d'), 1250);
    const transform = new THREE.Object3D();
    const grassColor = new THREE.Color();
    let grassIndex = 0;
    while (grassIndex < grasses.count) {
      const horizontal = (random() - 0.5) * 250;
      const depth = (random() - 0.65) * 240;
      if (Math.abs(horizontal) < 5.6 && depth > -72 && depth < 20) continue;
      transform.position.set(horizontal, 0, depth);
      transform.rotation.set(0, random() * Math.PI * 2, (random() - 0.5) * 0.18);
      const size = 0.4 + random() * 0.75;
      transform.scale.set(size, size, size);
      transform.updateMatrix();
      grasses.setMatrixAt(grassIndex, transform.matrix);
      grassColor.set(random() > 0.65 ? '#b5b48b' : '#8d9c79');
      grasses.setColorAt(grassIndex, grassColor);
      grassIndex += 1;
    }
    this.scene.add(grasses);
  }

  private buildMountains(): void {
    const random = randomGenerator(247);
    const createRidge = (depth: number, baseHeight: number, color: string, count: number, spacing: number) => {
      const positions: number[] = [];
      const colors: number[] = [];
      const shade = new THREE.Color(color);
      for (let index = 0; index < count; index += 1) {
        const horizontal = (index - count / 2) * spacing;
        const height = baseHeight * (0.55 + random() * 0.9);
        const summit = horizontal + (random() - 0.5) * spacing * 0.7;
        const ridgeDepth = depth + (random() - 0.5) * 60;
        const width = spacing * (1.2 + random() * 0.65);
        positions.push(horizontal - width, -2, ridgeDepth, summit, height, ridgeDepth - 20, horizontal + width, -2, ridgeDepth);
        positions.push(horizontal - width, -2, ridgeDepth, horizontal - width * 0.45, -2, ridgeDepth + 70, summit, height, ridgeDepth - 20);
        positions.push(summit, height, ridgeDepth - 20, horizontal - width * 0.45, -2, ridgeDepth + 70, horizontal + width, -2, ridgeDepth);
        for (let vertex = 0; vertex < 9; vertex += 1) {
          const variation = vertex < 3 ? 1 : vertex < 6 ? 0.92 : 1.035;
          colors.push(shade.r * variation, shade.g * variation, shade.b * variation);
        }
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      geometry.computeVertexNormals();
      const ridge = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
      this.scene.add(ridge);
    };
    createRidge(-500, 145, '#789597', 18, 65);
    createRidge(-340, 83, '#859782', 19, 43);
    createRidge(-230, 36, '#8c9a7d', 20, 35);

    const hillGeometry = new THREE.SphereGeometry(1, 14, 10);
    const hillMaterial = standardMaterial('#8a9c7b');
    for (let index = 0; index < 13; index += 1) {
      const hill = new THREE.Mesh(hillGeometry, hillMaterial);
      const side = index % 2 ? -1 : 1;
      hill.position.set(side * (180 + random() * 190), -13, 65 - random() * 330);
      hill.scale.set(65 + random() * 90, 22 + random() * 42, 65 + random() * 75);
      hill.receiveShadow = true;
      this.scene.add(hill);
    }
  }

  private buildTrees(): void {
    const random = randomGenerator(61);
    const treeCount = 340;
    const trunkGeometry = new THREE.CylinderGeometry(0.12, 0.23, 1, 6);
    trunkGeometry.translate(0, 0.5, 0);
    const foliageGeometry = new THREE.ConeGeometry(1, 1, 7);
    foliageGeometry.translate(0, 0.5, 0);
    const trunks = new THREE.InstancedMesh(trunkGeometry, standardMaterial('#706f55'), treeCount);
    const lowerFoliage = new THREE.InstancedMesh(foliageGeometry, standardMaterial('#71856b'), treeCount);
    const upperFoliage = new THREE.InstancedMesh(foliageGeometry, standardMaterial('#71856b'), treeCount);
    const transform = new THREE.Object3D();
    const color = new THREE.Color();
    for (let index = 0; index < treeCount; index += 1) {
      const side = random() > 0.5 ? -1 : 1;
      let horizontal = side * (72 + random() * 170);
      let depth = -55 - random() * 210;
      if (index < 60) {
        horizontal = (random() - 0.5) * 380;
        depth = -155 - random() * 95;
      }
      if (index > 295) {
        horizontal = side * (85 + random() * 80);
        depth = 15 + random() * 120;
      }
      const height = 6 + random() * 11;
      const width = height * (0.18 + random() * 0.055);
      const yaw = random() * Math.PI * 2;
      transform.position.set(horizontal, 0, depth);
      transform.rotation.set(0, yaw, 0);
      transform.scale.set(height * 0.12, height * 0.65, height * 0.12);
      transform.updateMatrix();
      trunks.setMatrixAt(index, transform.matrix);
      transform.position.y = height * 0.2;
      transform.scale.set(width, height * 0.6, width);
      transform.updateMatrix();
      lowerFoliage.setMatrixAt(index, transform.matrix);
      transform.position.y = height * 0.48;
      transform.scale.set(width * 0.77, height * 0.52, width * 0.77);
      transform.updateMatrix();
      upperFoliage.setMatrixAt(index, transform.matrix);
      color.setHSL(0.24 + random() * 0.05, 0.11 + random() * 0.07, 0.27 + random() * 0.15);
      lowerFoliage.setColorAt(index, color);
      upperFoliage.setColorAt(index, color.clone().multiplyScalar(1.06));
    }
    trunks.castShadow = true;
    lowerFoliage.castShadow = true;
    lowerFoliage.receiveShadow = true;
    upperFoliage.castShadow = true;
    this.scene.add(trunks, lowerFoliage, upperFoliage);
  }

  private buildCourse(): void {
    const creamMaterial = standardMaterial(COLORS.cream, { metalness: 0.25, roughness: 0.54 });
    const supportMaterial = standardMaterial('#77816e', { metalness: 0.35 });
    const footingMaterial = standardMaterial('#aaa98e');
    for (const [index, gate] of this.flightMap.gates.entries()) {
      const group = new THREE.Group();
      group.position.set(gate.position.x, gate.position.y, gate.position.z);
      group.rotation.y = gate.yaw;
      const ring = new THREE.Mesh(new THREE.TorusGeometry(gate.radius, 0.13, 9, 100), creamMaterial);
      ring.castShadow = true;
      group.add(ring);
      const accentMaterial = standardMaterial(COLORS.orange, { emissive: COLORS.orange, emissiveIntensity: 0.12, roughness: 0.62 });
      this.gateAccents.push(accentMaterial);
      for (let segment = 0; segment < 4; segment += 1) {
        const accent = new THREE.Mesh(new THREE.TorusGeometry(gate.radius, 0.146, 9, 12, Math.PI / 6), accentMaterial);
        accent.rotation.z = Math.PI / 6 + segment * Math.PI / 2;
        accent.castShadow = true;
        group.add(accent);
      }
      if (this.flightMap.id === 'pine-valley') {
        for (const side of [-1, 1]) {
          cylinderBetween(group, new THREE.Vector3(side * gate.radius, -gate.position.y + 0.2, 0), new THREE.Vector3(side * gate.radius, -0.2, 0), 0.052, supportMaterial);
          box(group, [0.8, 0.2, 1.15], [side * gate.radius, -gate.position.y + 0.1, 0], footingMaterial);
          box(group, [0.14, 0.4, 0.14], [side * gate.radius, -gate.position.y + 0.57, 0], accentMaterial);
        }
      }
      const numberTexture = canvasTexture(160, 96, (context) => {
        context.fillStyle = '#f0ead7';
        context.fillRect(0, 0, 160, 96);
        context.fillStyle = '#59664f';
        context.font = '500 55px Arial';
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillText(String(index + 1).padStart(2, '0'), 80, 50);
      });
      const label = new THREE.Mesh(new THREE.PlaneGeometry(1.05, 0.63), new THREE.MeshBasicMaterial({ map: numberTexture, side: THREE.DoubleSide }));
      label.position.set(0, gate.radius + 0.43, 0);
      group.add(label);
      const halo = new THREE.Mesh(new THREE.RingGeometry(gate.radius - 0.12, gate.radius + 0.24, 100), new THREE.MeshBasicMaterial({ color: COLORS.orange, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false }));
      halo.position.z = -0.035;
      group.add(halo);
      this.gateHalos.push(halo);
      this.scene.add(group);
    }

    if (this.flightMap.id === 'nyc') {
      supportMaterial.dispose();
      footingMaterial.dispose();
      return;
    }
    for (const horizontal of [-5.7, 5.7]) {
      for (let depth = 5; depth > -65; depth -= 12) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.09, 0.54, 8), supportMaterial);
        post.position.set(horizontal, 0.27, depth);
        post.castShadow = true;
        const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.13, 8), creamMaterial);
        cap.position.set(horizontal, 0.59, depth);
        this.scene.add(post, cap);
      }
    }
  }

  private buildScenery(): void {
    const random = randomGenerator(813);
    const rockGeometry = new THREE.DodecahedronGeometry(1, 0);
    const rocks = new THREE.InstancedMesh(rockGeometry, standardMaterial('#8b9380'), 70);
    const transform = new THREE.Object3D();
    for (let index = 0; index < rocks.count; index += 1) {
      const side = random() > 0.5 ? -1 : 1;
      const size = 0.25 + random() * 1.2;
      transform.position.set(side * (34 + random() * 140), size * 0.18, 55 - random() * 190);
      transform.rotation.set(random(), random() * Math.PI, random());
      transform.scale.set(size * 1.6, size * 0.6, size);
      transform.updateMatrix();
      rocks.setMatrixAt(index, transform.matrix);
    }
    rocks.castShadow = true;
    rocks.receiveShadow = true;
    this.scene.add(rocks);

    const darkMaterial = standardMaterial('#536258');
    const wallMaterial = standardMaterial('#d4d1b9');
    const windowMaterial = standardMaterial('#688687', { metalness: 0.28, roughness: 0.3 });
    const orangeMaterial = standardMaterial(COLORS.orange);
    const cabin = new THREE.Group();
    cabin.position.set(-34, 0, -30);
    cabin.rotation.y = 0.24;
    box(cabin, [6, 0.3, 4.7], [0, 0.15, 0], standardMaterial('#b8b59f'));
    box(cabin, [5.2, 2.7, 3.9], [0, 1.6, 0], wallMaterial);
    box(cabin, [5.7, 0.18, 4.4], [0, 3.04, 0], darkMaterial);
    box(cabin, [2.6, 1.1, 0.035], [-0.7, 1.95, 1.972], windowMaterial);
    box(cabin, [0.07, 1.12, 0.04], [-0.7, 1.95, 2.0], wallMaterial);
    box(cabin, [0.86, 2.15, 0.06], [1.72, 1.36, 1.98], darkMaterial);
    box(cabin, [0.6, 0.07, 0.07], [1.72, 2.67, 2.02], orangeMaterial);
    cylinderBetween(cabin, new THREE.Vector3(-1.5, 3.1, 0), new THREE.Vector3(-1.5, 6.2, 0), 0.035, darkMaterial);
    cylinderBetween(cabin, new THREE.Vector3(-2.1, 5.4, 0), new THREE.Vector3(-0.9, 5.4, 0), 0.025, darkMaterial);
    this.scene.add(cabin);

    const windPole = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.075, 5.6, 10), darkMaterial);
    windPole.position.set(-12, 2.8, -12);
    windPole.castShadow = true;
    this.scene.add(windPole);
    this.windsock.position.set(-12, 5.5, -12);
    cylinderBetween(this.windsock, new THREE.Vector3(0, -0.1, 0), new THREE.Vector3(0.43, 0.12, 0), 0.022, darkMaterial);
    const sockGroup = new THREE.Group();
    sockGroup.position.set(0.42, 0.07, 0);
    sockGroup.rotation.z = -Math.PI / 2 + 0.16;
    for (let index = 0; index < 5; index += 1) {
      const section = new THREE.Mesh(new THREE.CylinderGeometry(0.28 - index * 0.035, 0.245 - index * 0.035, 0.36, 14, 1, true), index % 2 === 0 ? orangeMaterial : wallMaterial);
      section.position.y = index * 0.36;
      section.material.side = THREE.DoubleSide;
      sockGroup.add(section);
    }
    this.windsock.add(sockGroup);
    this.scene.add(this.windsock);

    const bench = new THREE.Group();
    bench.position.set(-9, 0, 7);
    box(bench, [2.6, 0.14, 0.58], [0, 0.65, 0], standardMaterial('#a99572'));
    for (const horizontal of [-0.95, 0.95]) {
      box(bench, [0.1, 0.6, 0.42], [horizontal, 0.3, 0], darkMaterial);
    }
    box(bench, [0.74, 0.44, 0.49], [0.38, 0.92, 0], standardMaterial('#4a5551'));
    box(bench, [0.32, 0.025, 0.24], [0.38, 1.15, 0], orangeMaterial);
    this.scene.add(bench);
  }

  private buildDrone(): void {
    const bodyMaterial = standardMaterial('#283530', { metalness: 0.48, roughness: 0.48 });
    const shellMaterial = standardMaterial('#49534b', { metalness: 0.33, roughness: 0.58 });
    const orangeMaterial = standardMaterial('#e98d54', { metalness: 0.22, roughness: 0.48 });
    const motorMaterial = standardMaterial('#a9aca0', { metalness: 0.72, roughness: 0.31 });
    const propellerMaterial = standardMaterial('#27312e', { metalness: 0.2, roughness: 0.53, side: THREE.DoubleSide });
    const lensMaterial = standardMaterial('#203f44', { metalness: 0.6, roughness: 0.08 });
    this.drone.add(this.body);
    box(this.body, [0.48, 0.15, 0.67], [0, 0, 0], bodyMaterial);
    box(this.body, [0.4, 0.09, 0.56], [0, 0.1, 0.035], shellMaterial);
    box(this.body, [0.28, 0.1, 0.38], [0, 0.19, 0.04], bodyMaterial);
    box(this.body, [0.085, 0.012, 0.4], [0, 0.247, 0.04], orangeMaterial);
    box(this.body, [0.47, 0.022, 0.07], [0, 0.138, 0.26], orangeMaterial);
    box(this.body, [0.39, 0.045, 0.025], [0, 0.04, 0.35], this.statusLights);

    for (const horizontal of [-1, 1]) {
      for (const depth of [-1, 1]) {
        const motorPosition = new THREE.Vector3(horizontal * 0.65, 0.035, depth * 0.59);
        cylinderBetween(this.body, new THREE.Vector3(horizontal * 0.14, 0, depth * 0.19), motorPosition, 0.05, bodyMaterial);
        cylinderBetween(this.body, new THREE.Vector3(horizontal * 0.35, -0.035, depth * 0.32), new THREE.Vector3(horizontal * 0.42, -0.22, depth * 0.39), 0.027, bodyMaterial);
        box(this.body, [0.17, 0.032, 0.1], [horizontal * 0.43, -0.229, depth * 0.4], shellMaterial);
        const motor = new THREE.Mesh(new THREE.CylinderGeometry(0.091, 0.1, 0.13, 16), motorMaterial);
        motor.position.copy(motorPosition);
        motor.castShadow = true;
        this.body.add(motor);
        const motorCap = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.045, 16), depth < 0 ? orangeMaterial : bodyMaterial);
        motorCap.position.copy(motorPosition).add(new THREE.Vector3(0, 0.075, 0));
        this.body.add(motorCap);
        const propeller = new THREE.Group();
        propeller.position.copy(motorPosition).add(new THREE.Vector3(0, 0.117, 0));
        const blade = new THREE.Mesh(new THREE.CapsuleGeometry(0.037, 0.58, 3, 8), propellerMaterial);
        blade.rotation.z = Math.PI / 2;
        blade.scale.set(0.18, 1, 1.05);
        blade.castShadow = true;
        propeller.add(blade);
        const hub = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 6), bodyMaterial);
        hub.scale.y = 0.6;
        propeller.add(hub);
        propeller.rotation.y = horizontal * depth * 0.55;
        this.propellers.push(propeller);
        this.body.add(propeller);
      }
    }

    const cameraHousing = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.17, 0.15), shellMaterial);
    cameraHousing.position.set(0, -0.035, -0.38);
    this.body.add(cameraHousing);
    const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.065, 0.055, 18), lensMaterial);
    lens.rotation.x = Math.PI / 2;
    lens.position.set(0, -0.029, -0.473);
    this.body.add(lens);
    const lensRing = new THREE.Mesh(new THREE.TorusGeometry(0.069, 0.012, 6, 18), motorMaterial);
    lensRing.position.set(0, -0.029, -0.506);
    this.body.add(lensRing);
    cylinderBetween(this.body, new THREE.Vector3(0.13, 0.16, 0.2), new THREE.Vector3(0.16, 0.48, 0.32), 0.009, bodyMaterial, 5);
    const antennaTop = new THREE.Mesh(new THREE.SphereGeometry(0.022, 8, 6), orangeMaterial);
    antennaTop.position.set(0.16, 0.48, 0.32);
    this.body.add(antennaTop);
    this.scene.add(this.drone);
  }

  render(state: FlightState, delta: number, cameraMode: CameraMode, activeGate: number): void {
    if (this.disposed) return;
    const frameDelta = Math.min(Math.max(delta, 0), 0.1);
    this.elapsed += frameDelta;
    this.drone.position.set(state.position.x, state.position.y, state.position.z);
    this.drone.rotation.y = -state.yaw;
    this.body.rotation.set(state.pitch, 0, state.roll, 'YXZ');
    this.drone.visible = cameraMode !== 'fpv';
    if (state.armed && !state.crashed) {
      for (const [index, propeller] of this.propellers.entries()) {
        propeller.rotation.y += frameDelta * (index % 2 ? 79 : -79);
      }
    }
    this.statusLights.color.set(state.crashed ? '#d7654c' : state.armed ? '#8be1bb' : '#98b6a0');
    this.statusLights.emissive.set(state.crashed ? '#d75d37' : '#6ec797');
    this.statusLights.emissiveIntensity = state.armed ? 0.65 : 0.15;
    let shadowSurfaceHeight = 0;
    for (const building of this.flightMap.buildings) {
      for (const tier of building.tiers) {
        const roofHeight = tier.base + tier.height;
        if (roofHeight > shadowSurfaceHeight && roofHeight <= state.position.y + 0.01
          && Math.abs(state.position.x - building.x) <= tier.width / 2
          && Math.abs(state.position.z - building.z) <= tier.depth / 2) {
          shadowSurfaceHeight = roofHeight;
        }
      }
    }
    const shadowHeight = Math.max(0, state.position.y - shadowSurfaceHeight);
    this.shadow.position.set(state.position.x, shadowSurfaceHeight + 0.047, state.position.z);
    this.shadow.scale.setScalar(1 + shadowHeight * 0.075);
    this.shadow.material.opacity = Math.max(0.025, 0.78 / (1 + shadowHeight * 0.3));
    this.windsock.rotation.y = -0.45 + Math.sin(this.elapsed * 0.8) * 0.12;
    this.windsock.rotation.z = Math.sin(this.elapsed * 2.4) * 0.025;

    if (this.previousActiveGate !== activeGate) {
      this.gateAccents.forEach((material, index) => {
        material.color.set(index === activeGate ? '#ed8950' : index < activeGate ? '#8aa280' : '#c6a276');
        material.emissiveIntensity = index === activeGate ? 0.18 : 0;
        this.gateHalos[index].visible = index === activeGate;
      });
      this.previousActiveGate = activeGate;
    }
    const activeHalo = this.gateHalos[activeGate];
    if (activeHalo) {
      (activeHalo.material as THREE.MeshBasicMaterial).opacity = 0.1 + (Math.sin(this.elapsed * 2) + 1) * 0.035;
    }

    this.forward.set(Math.sin(state.yaw), 0, -Math.cos(state.yaw));
    const modeChanged = this.previousCameraMode !== cameraMode;
    if (cameraMode === 'fpv') {
      this.cameraOrientation.copy(this.drone.quaternion).multiply(this.body.quaternion);
      this.desiredPosition.set(0, 0.12, -0.4).applyQuaternion(this.cameraOrientation).add(this.drone.position);
      this.desiredTarget.set(0, 0, -20).applyQuaternion(this.cameraOrientation).add(this.desiredPosition);
      this.cameraPosition.copy(this.desiredPosition);
      this.cameraTarget.copy(this.desiredTarget);
      this.camera.up.set(0, 1, 0).applyQuaternion(this.cameraOrientation);
    } else {
      this.camera.up.set(0, 1, 0);
      if (cameraMode === 'orbit') {
        if (this.flightMap.id === 'nyc') {
          this.desiredPosition.copy(this.drone.position).add(new THREE.Vector3(-28, 24, 30));
        } else {
          this.desiredPosition.set(33, Math.max(24, state.position.y * 0.5 + 15), 30);
        }
        this.desiredTarget.copy(this.drone.position).add(new THREE.Vector3(0, 0.7, 0));
      } else {
        const speed = Math.hypot(state.velocity.x, state.velocity.z);
        this.desiredPosition.copy(this.drone.position).addScaledVector(this.forward, -9.4 - Math.min(speed * 0.13, 2.7));
        this.desiredPosition.y += this.flightMap.id === 'nyc' ? 4.8 : 4.2;
        this.desiredTarget.copy(this.drone.position).addScaledVector(this.forward, 9);
        this.desiredTarget.y += this.flightMap.id === 'nyc' ? 3.4 : 1.8;
      }
      this.clipCityCamera(this.desiredPosition);
      if (this.cameraNeedsReset || modeChanged) {
        this.cameraPosition.copy(this.desiredPosition);
        this.cameraTarget.copy(this.desiredTarget);
      } else {
        this.cameraPosition.lerp(this.desiredPosition, 1 - Math.exp(-frameDelta * 5));
        this.cameraTarget.lerp(this.desiredTarget, 1 - Math.exp(-frameDelta * 6));
      }
      this.clipCityCamera(this.cameraPosition);
    }
    this.camera.position.copy(this.cameraPosition);
    this.camera.lookAt(this.cameraTarget);
    this.cameraNeedsReset = false;
    this.previousCameraMode = cameraMode;
    this.renderer.render(this.scene, this.camera);
  }

  resetCamera(): void {
    this.cameraNeedsReset = true;
  }

  private clipCityCamera(position: THREE.Vector3): void {
    if (!this.buildingBounds.length) return;
    this.cameraRay.origin.copy(this.drone.position).add(new THREE.Vector3(0, 0.3, 0));
    this.cameraRay.direction.copy(position).sub(this.cameraRay.origin);
    const distance = this.cameraRay.direction.length();
    if (distance < 0.001) return;
    this.cameraRay.direction.divideScalar(distance);
    let nearest = distance;
    for (const bounds of this.buildingBounds) {
      const hit = this.cameraRay.intersectBox(bounds, this.cameraHit);
      if (hit) nearest = Math.min(nearest, Math.max(0.3, hit.distanceTo(this.cameraRay.origin) - 0.25));
    }
    if (nearest < distance) this.cameraRay.at(nearest, position);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.observer.disconnect();
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    const textures = new Set<THREE.Texture>();
    this.scene.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Sprite) {
        if (object instanceof THREE.Mesh) geometries.add(object.geometry);
        const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
        objectMaterials.forEach((material) => {
          materials.add(material);
          for (const value of Object.values(material)) {
            if (value instanceof THREE.Texture) textures.add(value);
          }
        });
      }
      if (object instanceof THREE.Light && 'shadow' in object) {
        const light = object as THREE.DirectionalLight;
        light.shadow?.map?.dispose();
      }
      if (object instanceof THREE.InstancedMesh) object.dispose();
    });
    geometries.forEach((geometry) => geometry.dispose());
    materials.forEach((material) => material.dispose());
    textures.forEach((texture) => texture.dispose());
    this.scene.clear();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
