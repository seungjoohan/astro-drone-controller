import * as THREE from 'three';
import { CITY_BLOCK_SIZE, CITY_PARK, type BuildingStyle, type FlightMap } from './maps';

interface Instance {
  position: [number, number, number];
  scale: [number, number, number];
  yaw?: number;
  color?: string;
}

interface FacadeBatch {
  positions: number[];
  normals: number[];
  coordinates: number[];
  indices: number[];
}

const PALETTES: Record<BuildingStyle, string[]> = {
  brick: ['#995b47', '#7a5145', '#b37b5a', '#66504a', '#956955'],
  stone: ['#c1b8a4', '#a49e90', '#cdbfa4', '#968f83', '#b8ad97'],
  glass: ['#8cb4c9', '#6c96ab', '#a2bbc5', '#6f9faa', '#8b9eac'],
  landmark: ['#d0c4ab', '#d0c4ab', '#d0c4ab', '#d0c4ab', '#d0c4ab'],
};

function material(color: string, options: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0.02, ...options });
}

function randomGenerator(seed: number): () => number {
  let value = seed;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

function texture(width: number, height: number, paint: (context: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('The city textures could not be created.');
  paint(context);
  const result = new THREE.CanvasTexture(canvas);
  result.colorSpace = THREE.SRGBColorSpace;
  result.wrapS = result.wrapT = THREE.RepeatWrapping;
  result.anisotropy = 4;
  return result;
}

function instances(parent: THREE.Object3D, geometry: THREE.BufferGeometry, surface: THREE.Material, entries: Instance[], shadows = true): void {
  if (!entries.length) {
    geometry.dispose();
    surface.dispose();
    return;
  }
  const mesh = new THREE.InstancedMesh(geometry, surface, entries.length);
  const transform = new THREE.Object3D();
  const color = new THREE.Color();
  entries.forEach((entry, index) => {
    transform.position.set(...entry.position);
    transform.scale.set(...entry.scale);
    transform.rotation.set(0, entry.yaw ?? 0, 0);
    transform.updateMatrix();
    mesh.setMatrixAt(index, transform.matrix);
    if (entry.color) mesh.setColorAt(index, color.set(entry.color));
  });
  mesh.castShadow = shadows;
  mesh.receiveShadow = true;
  mesh.computeBoundingSphere();
  parent.add(mesh);
}

function boxes(parent: THREE.Object3D, color: string, entries: Instance[], shadows = true): void {
  instances(parent, new THREE.BoxGeometry(1, 1, 1), material(color), entries, shadows);
}

function facadeTexture(style: BuildingStyle, variant: number): THREE.CanvasTexture {
  const random = randomGenerator(500 + variant * 71 + style.length * 31);
  return texture(256, 512, (context) => {
    const glass = style === 'glass';
    context.fillStyle = PALETTES[style][variant % 5];
    context.fillRect(0, 0, 256, 512);
    if (style === 'brick') {
      context.strokeStyle = 'rgba(49, 35, 29, 0.22)';
      context.lineWidth = 1;
      for (let row = 0; row < 64; row += 1) {
        context.beginPath();
        context.moveTo(0, row * 8);
        context.lineTo(256, row * 8);
        context.stroke();
        for (let column = 0; column < 12; column += 1) {
          context.fillStyle = 'rgba(233, 180, 139, 0.12)';
          context.fillRect(column * 24 + (row % 2) * 12, row * 8, 1, 8);
        }
      }
    }
    for (let row = 0; row < 8; row += 1) {
      for (let column = 0; column < 4; column += 1) {
        const left = column * 64 + (glass ? 2 : style === 'landmark' ? 19 : 15);
        const top = row * 64 + (glass ? 2 : 12);
        const width = glass ? 60 : style === 'landmark' ? 26 : 34;
        const height = glass ? 59 : 41;
        context.fillStyle = glass ? '#4d6975' : '#5f5a50';
        context.fillRect(left - 2, top - 2, width + 4, height + 5);
        const reflection = context.createLinearGradient(left, top, left + width, top + height);
        const bright = random() > 0.68;
        reflection.addColorStop(0, glass ? bright ? '#b0d4e1' : '#739bae' : '#71818a');
        reflection.addColorStop(0.52, glass ? '#6a94aa' : '#3b4d57');
        reflection.addColorStop(1, glass ? '#8db3bf' : '#273c48');
        context.fillStyle = reflection;
        context.fillRect(left, top, width, height);
        if (!glass && random() > 0.76) {
          context.fillStyle = random() > 0.5 ? '#acac9e' : '#788c92';
          context.fillRect(left, top, width, height * (0.24 + random() * 0.42));
        }
        context.fillStyle = glass ? 'rgba(218, 237, 237, 0.7)' : '#a49e8f';
        context.fillRect(left + width / 2, top, glass ? 1 : 2, height);
        if (!glass) context.fillRect(left, top + height * 0.53, width, 2);
        context.fillStyle = glass ? '#aac2c9' : '#cec0a7';
        context.fillRect(left - 2, top + height + 1, width + 4, glass ? 1 : 3);
      }
      if (style === 'stone' || style === 'landmark') {
        context.fillStyle = 'rgba(77, 74, 68, 0.22)';
        context.fillRect(0, row * 64 + 62, 256, 2);
      }
    }
    if (style === 'landmark') {
      context.fillStyle = '#e4d9bf';
      for (let column = 0; column < 4; column += 1) context.fillRect(column * 64 + 6, 0, 5, 512);
    }
  });
}

function addFacade(batch: FacadeBatch, corners: number[][], normal: [number, number, number], width: number, height: number, base: number): void {
  const first = batch.positions.length / 3;
  corners.forEach((corner) => {
    batch.positions.push(...corner);
    batch.normals.push(...normal);
  });
  batch.coordinates.push(0, base / 27.2, width / 13.6, base / 27.2, width / 13.6, (base + height) / 27.2, 0, (base + height) / 27.2);
  batch.indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
}

function buildBuildings(parent: THREE.Object3D, map: FlightMap): void {
  const batches = new Map<string, FacadeBatch>();
  const roofs: Instance[] = [];
  const cornices: Instance[] = [];
  const equipment: Instance[] = [];
  const towerTanks: Instance[] = [];
  const towerRoofs: Instance[] = [];
  const towerLegs: Instance[] = [];
  const awnings: Instance[] = [];
  const random = randomGenerator(972);
  for (const building of map.buildings) {
    const key = `${building.style}:${building.variant}`;
    const batch = batches.get(key) ?? { positions: [], normals: [], coordinates: [], indices: [] };
    batches.set(key, batch);
    for (const tier of building.tiers) {
      const left = building.x - tier.width / 2;
      const right = building.x + tier.width / 2;
      const front = building.z + tier.depth / 2;
      const back = building.z - tier.depth / 2;
      const bottom = tier.base;
      const top = tier.base + tier.height;
      addFacade(batch, [[left, bottom, front], [right, bottom, front], [right, top, front], [left, top, front]], [0, 0, 1], tier.width, tier.height, tier.base);
      addFacade(batch, [[right, bottom, back], [left, bottom, back], [left, top, back], [right, top, back]], [0, 0, -1], tier.width, tier.height, tier.base);
      addFacade(batch, [[right, bottom, front], [right, bottom, back], [right, top, back], [right, top, front]], [1, 0, 0], tier.depth, tier.height, tier.base);
      addFacade(batch, [[left, bottom, back], [left, bottom, front], [left, top, front], [left, top, back]], [-1, 0, 0], tier.depth, tier.height, tier.base);
      roofs.push({ position: [building.x, top - 0.12, building.z], scale: [tier.width, 0.24, tier.depth], color: building.style === 'glass' ? '#758891' : '#8b877c' });
      if (tier.width > 5) {
        const corniceColor = building.style === 'brick' ? '#baa58d' : building.style === 'glass' ? '#c1d2d3' : '#d0c7b3';
        for (const side of [-1, 1]) {
          cornices.push({ position: [building.x, top - 0.42, building.z + side * (tier.depth / 2 - 0.08)], scale: [tier.width, 0.6, 0.26], color: corniceColor });
          cornices.push({ position: [building.x + side * (tier.width / 2 - 0.08), top - 0.42, building.z], scale: [0.26, 0.6, tier.depth], color: corniceColor });
        }
      }
    }
    const finalTier = building.tiers[building.tiers.length - 1];
    const rooftop = finalTier.base + finalTier.height;
    if (finalTier.width > 10) {
      equipment.push({ position: [building.x + 2, rooftop + 0.65, building.z + 2], scale: [3.6, 1.3, 2.5] });
      equipment.push({ position: [building.x + 2, rooftop + 1.35, building.z + 2], scale: [3.8, 0.1, 2.7], color: '#48585b' });
      if (building.style !== 'glass' && random() > 0.57) {
        const tankX = building.x - 3;
        const tankZ = building.z - 3;
        towerTanks.push({ position: [tankX, rooftop + 3.5, tankZ], scale: [1.45, 2.7, 1.45] });
        towerRoofs.push({ position: [tankX, rooftop + 5.3, tankZ], scale: [1.65, 1, 1.65] });
        for (const horizontal of [-1, 1]) {
          for (const depth of [-1, 1]) towerLegs.push({ position: [tankX + horizontal, rooftop + 1, tankZ + depth], scale: [0.14, 2, 0.14] });
        }
      }
    }
    if (building.style === 'brick') {
      const base = building.tiers[0];
      awnings.push({ position: [building.x, 3.6, building.z + base.depth / 2 + 0.35], scale: [base.width * 0.7, 0.35, 0.75], color: building.variant % 2 ? '#435d58' : '#933f38' });
    }
  }
  for (const [key, batch] of batches) {
    const [styleName, variant] = key.split(':');
    const style = styleName as BuildingStyle;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(batch.positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(batch.normals, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(batch.coordinates, 2));
    geometry.setIndex(batch.indices);
    geometry.computeBoundingSphere();
    const surface = material('#ffffff', { map: facadeTexture(style, Number(variant)), roughness: style === 'glass' ? 0.39 : 0.88, metalness: style === 'glass' ? 0.22 : 0.02 });
    const mesh = new THREE.Mesh(geometry, surface);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
  }
  boxes(parent, '#ffffff', roofs);
  boxes(parent, '#ffffff', cornices);
  boxes(parent, '#a5aaa5', equipment);
  boxes(parent, '#50534e', towerLegs);
  boxes(parent, '#ffffff', awnings);
  instances(parent, new THREE.CylinderGeometry(1, 1, 1, 10), material('#8b6a4e'), towerTanks);
  instances(parent, new THREE.ConeGeometry(1, 1, 10), material('#657578'), towerRoofs);
}

function buildStreets(parent: THREE.Object3D): void {
  const random = randomGenerator(619);
  const asphaltTexture = texture(256, 256, (context) => {
    context.fillStyle = '#657074';
    context.fillRect(0, 0, 256, 256);
    for (let index = 0; index < 9000; index += 1) {
      context.fillStyle = random() > 0.5 ? 'rgba(224, 228, 224, 0.045)' : 'rgba(16, 28, 36, 0.06)';
      context.fillRect(random() * 256, random() * 256, 1, 1);
    }
  });
  asphaltTexture.repeat.set(40, 40);
  const ocean = new THREE.Mesh(new THREE.PlaneGeometry(1900, 1900), material('#6c9fab', { roughness: 0.42, metalness: 0.15 }));
  ocean.rotation.x = -Math.PI / 2;
  ocean.position.y = -1.5;
  parent.add(ocean);
  const land = new THREE.Mesh(new THREE.BoxGeometry(566, 2, 566), material('#c0b9a7'));
  land.position.y = -1.06;
  land.receiveShadow = true;
  parent.add(land);
  const asphalt = new THREE.Mesh(new THREE.PlaneGeometry(552, 552), material('#ffffff', { map: asphaltTexture }));
  asphalt.rotation.x = -Math.PI / 2;
  asphalt.position.y = 0.005;
  asphalt.receiveShadow = true;
  parent.add(asphalt);
  const sidewalks: Instance[] = [];
  const yellow: Instance[] = [];
  const white: Instance[] = [];
  const curb: Instance[] = [];
  for (let column = -4; column < 4; column += 1) {
    for (let row = -4; row < 4; row += 1) {
      const horizontal = (column + 0.5) * CITY_BLOCK_SIZE;
      const depth = (row + 0.5) * CITY_BLOCK_SIZE;
      sidewalks.push({ position: [horizontal, 0.075, depth], scale: [48, 0.15, 48] });
      for (const side of [-1, 1]) {
        curb.push({ position: [horizontal + side * 23.9, 0.17, depth], scale: [0.18, 0.06, 48] });
        curb.push({ position: [horizontal, 0.17, depth + side * 23.9], scale: [48, 0.06, 0.18] });
      }
    }
  }
  for (let street = -4; street <= 4; street += 1) {
    const center = street * CITY_BLOCK_SIZE;
    for (let section = -4; section < 4; section += 1) {
      const midpoint = (section + 0.5) * CITY_BLOCK_SIZE;
      for (const side of [-1, 1]) {
        yellow.push({ position: [center + side * 0.2, 0.024, midpoint], scale: [0.13, 0.018, 36] });
        yellow.push({ position: [midpoint, 0.024, center + side * 0.2], scale: [36, 0.018, 0.13] });
      }
    }
    for (let crossing = -4; crossing <= 4; crossing += 1) {
      const depth = crossing * CITY_BLOCK_SIZE;
      for (const side of [-1, 1]) {
        for (let stripe = -3; stripe <= 3; stripe += 1) {
          white.push({ position: [center + stripe * 1.8, 0.025, depth + side * 10.3], scale: [0.85, 0.018, 3.2] });
          white.push({ position: [center + side * 10.3, 0.025, depth + stripe * 1.8], scale: [3.2, 0.018, 0.85] });
        }
        white.push({ position: [center + side * 3.8, 0.025, depth + side * 13.3], scale: [6.8, 0.018, 0.25] });
        white.push({ position: [center + side * 13.3, 0.025, depth - side * 3.8], scale: [0.25, 0.018, 6.8] });
      }
    }
  }
  boxes(parent, '#c5c4b9', sidewalks, false);
  boxes(parent, '#e0d9c6', curb, false);
  boxes(parent, '#e9c06b', yellow, false);
  boxes(parent, '#e8e6d9', white, false);

  const padTexture = texture(512, 512, (context) => {
    context.fillStyle = '#263d42';
    context.fillRect(0, 0, 512, 512);
    context.strokeStyle = '#edac64';
    context.lineWidth = 12;
    context.beginPath();
    context.arc(256, 256, 227, 0, Math.PI * 2);
    context.stroke();
    context.strokeStyle = '#d9dfd4';
    context.lineWidth = 2;
    context.beginPath();
    context.arc(256, 256, 209, 0, Math.PI * 2);
    context.stroke();
    context.fillStyle = '#f0ead6';
    context.font = '600 190px Arial';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText('H', 256, 267);
    context.font = '600 19px Arial';
    context.fillText('MIDTOWN / FLIGHT LAB', 256, 117);
    context.fillStyle = '#edac64';
    context.beginPath();
    context.moveTo(256, 36);
    context.lineTo(243, 65);
    context.lineTo(269, 65);
    context.fill();
  });
  const pad = new THREE.Mesh(new THREE.CircleGeometry(4, 80), material('#ffffff', { map: padTexture }));
  pad.rotation.x = -Math.PI / 2;
  pad.position.y = 0.045;
  pad.receiveShadow = true;
  parent.add(pad);
}

function buildStreetLife(parent: THREE.Object3D): void {
  const poles: Instance[] = [];
  const arms: Instance[] = [];
  const lamps: Instance[] = [];
  const signs: Instance[] = [];
  const taxiBodies: Instance[] = [];
  const taxiWindows: Instance[] = [];
  const taxiSigns: Instance[] = [];
  const wheels: Instance[] = [];
  const random = randomGenerator(628);
  for (let column = -3; column <= 3; column += 1) {
    for (let row = -3; row <= 3; row += 1) {
      const horizontal = column * CITY_BLOCK_SIZE;
      const depth = row * CITY_BLOCK_SIZE;
      for (const side of [-1, 1]) {
        poles.push({ position: [horizontal + side * 9, 4.1, depth + side * 15], scale: [0.13, 8, 0.13] });
        arms.push({ position: [horizontal + side * 7.8, 8, depth + side * 15], scale: [2.5, 0.13, 0.13] });
        lamps.push({ position: [horizontal + side * 6.7, 7.9, depth + side * 15], scale: [0.95, 0.15, 0.4] });
      }
      signs.push({ position: [horizontal + 9, 5.6, depth + 15], scale: [2.4, 0.65, 0.08] });
      if (random() > 0.17) {
        const taxiX = horizontal + (random() > 0.5 ? 3.5 : -3.5);
        const taxiZ = depth + 23 + random() * 17;
        taxiBodies.push({ position: [taxiX, 0.78, taxiZ], scale: [1.85, 0.9, 4.3] });
        taxiWindows.push({ position: [taxiX, 1.5, taxiZ + 0.15], scale: [1.58, 0.75, 2.15] });
        taxiBodies.push({ position: [taxiX, 1.91, taxiZ + 0.15], scale: [1.67, 0.12, 2.2] });
        taxiSigns.push({ position: [taxiX, 2.12, taxiZ + 0.15], scale: [0.85, 0.35, 0.3] });
        for (const side of [-1, 1]) {
          for (const end of [-1, 1]) wheels.push({ position: [taxiX + side * 0.92, 0.43, taxiZ + end * 1.3], scale: [0.19, 0.64, 0.64] });
        }
      }
    }
  }
  boxes(parent, '#596b6c', poles);
  boxes(parent, '#596b6c', arms);
  boxes(parent, '#ebdfb6', lamps);
  boxes(parent, '#367266', signs);
  boxes(parent, '#efb735', taxiBodies);
  boxes(parent, '#4a6876', taxiWindows);
  boxes(parent, '#f0ddab', taxiSigns);
  boxes(parent, '#344044', wheels);
}

function buildPark(parent: THREE.Object3D): void {
  const park = new THREE.Group();
  park.position.set(CITY_PARK.x, 0.16, CITY_PARK.z);
  parent.add(park);
  boxes(park, '#859b6c', [{ position: [0, 0.03, 0], scale: [CITY_PARK.width, 0.06, CITY_PARK.depth] }], false);
  boxes(park, '#d2c7ae', [
    { position: [0, 0.08, 0], scale: [44, 0.025, 2.5] },
    { position: [0, 0.08, 0], scale: [2.5, 0.025, 44] },
  ], false);
  const fountainBase = new THREE.Mesh(new THREE.CylinderGeometry(5.5, 5.7, 0.45, 40), material('#cfccbc'));
  fountainBase.position.y = 0.3;
  fountainBase.receiveShadow = true;
  park.add(fountainBase);
  const fountainWater = new THREE.Mesh(new THREE.CircleGeometry(4.8, 40), material('#77b7b4', { roughness: 0.25, metalness: 0.22 }));
  fountainWater.rotation.x = -Math.PI / 2;
  fountainWater.position.y = 0.54;
  park.add(fountainWater);
  const trunks: Instance[] = [];
  const crowns: Instance[] = [];
  const benches: Instance[] = [];
  const random = randomGenerator(715);
  for (let index = 0; index < 40; index += 1) {
    const horizontal = (random() > 0.5 ? 1 : -1) * (7 + random() * 12);
    const depth = (random() > 0.5 ? 1 : -1) * (7 + random() * 12);
    const height = 5.5 + random() * 3;
    trunks.push({ position: [horizontal, height * 0.3, depth], scale: [0.22, height * 0.6, 0.22] });
    crowns.push({ position: [horizontal, height * 0.78, depth], scale: [2.3, height * 0.42, 2.3], color: ['#729661', '#587e58', '#90a76c'][index % 3] });
  }
  for (const horizontal of [-10, 10]) {
    for (const depth of [-3, 3]) {
      benches.push({ position: [horizontal, 0.65, depth], scale: [2.5, 0.2, 0.6] });
      benches.push({ position: [horizontal, 1.05, depth + Math.sign(depth) * 0.25], scale: [2.5, 0.65, 0.1] });
    }
  }
  instances(park, new THREE.CylinderGeometry(0.8, 1, 1, 6), material('#7b6650'), trunks);
  instances(park, new THREE.IcosahedronGeometry(1, 1), material('#ffffff'), crowns);
  boxes(park, '#9d8160', benches);
}

export function buildCity(parent: THREE.Object3D, map: FlightMap): void {
  buildStreets(parent);
  buildBuildings(parent, map);
  buildStreetLife(parent);
  buildPark(parent);
}
