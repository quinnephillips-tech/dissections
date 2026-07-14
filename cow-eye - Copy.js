import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const canvas = document.getElementById('dissectionCanvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.localClippingEnabled = true;
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(canvas.clientWidth, canvas.clientHeight);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf4f7fb);

const camera = new THREE.PerspectiveCamera(45, canvas.clientWidth / canvas.clientHeight, 0.1, 100);
camera.position.set(0, 0, 6);

const ambientLight = new THREE.AmbientLight(0xffffff, 0.95);
scene.add(ambientLight);

const directionalLight = new THREE.DirectionalLight(0xffffff, 1.15);
directionalLight.position.set(3, 3, 5);
directionalLight.castShadow = true;
scene.add(directionalLight);

const group = new THREE.Group();
group.name = 'eyeGroup';
scene.add(group);

const loader = new GLTFLoader();
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const cutSlider = document.getElementById('incisionRange');
const incisionValue = document.getElementById('incisionValue');

const interactableNames = new Set([
  'front_fat',
  'back_fat',
  'sclera',
  'lens',
  'iris',
  'cornea',
  'interior',
  'vitreous',
  'retina',
  'tapetum',
  'optic_nerve'
]);

const probeTargets = new Set([
  'sclera',
  'lens',
  'iris',
  'cornea',
  'interior',
  'vitreous',
  'retina',
  'tapetum',
  'optic_nerve'
]);

let loadedModel = null;
let lastClickPosition = { x: 0, y: 0 };
let isDragging = false;
let previousX = 0;
let previousY = 0;
let activeTool = 'rotate';
let clippingPlane = null;
let cutBounds = null;
let cutFraction = 0;
const materialClippingTargets = [];
const worldNormal = new THREE.Vector3();
const worldPoint = new THREE.Vector3();
const worldPosition = new THREE.Vector3();
const tempQuat = new THREE.Quaternion();
// Mesh correction offsets for cornea and lens. These are zeroed by default
// so the imported GLB's baked transform is preserved unless a tweak is needed.
const meshCorrections = {
  cornea: {
    rotationOffsetX: 0,
    rotationOffsetY: -Math.PI / 2,
    rotationOffsetZ: 0,
    positionOffsetX: -2.524,
    positionOffsetY: 0,
    positionOffsetZ: 0
  },
  lens: {
    rotationOffsetX: 0,
    rotationOffsetY: -Math.PI / 2,
    rotationOffsetZ: 0,
    positionOffsetX: -2.524,
    positionOffsetY: 0,
    positionOffsetZ: 0
  },
  retina: {
    rotationOffsetX: Math.PI / 2,
    rotationOffsetY: 0,
    rotationOffsetZ: 0,
    positionOffsetX: 0,
    positionOffsetY: 0,
    positionOffsetZ: 0
  }
};

const rootOrientationCorrection = {
  x: 0,
  y: 0,
  z: 0
};

const rootPositionCorrection = {
  x: 0,
  y: 0,
  z: 0
};

function applyRootOrientationCorrection(rootObject) {
  if (!rootObject) return;
  rootObject.rotation.set(
    rootObject.rotation.x + (rootOrientationCorrection.x || 0),
    rootObject.rotation.y + (rootOrientationCorrection.y || 0),
    rootObject.rotation.z + (rootOrientationCorrection.z || 0)
  );
}

function applyRootPositionCorrection(rootObject) {
  if (!rootObject) return;
  rootObject.position.set(
    rootObject.position.x + (rootPositionCorrection.x || 0),
    rootObject.position.y + (rootPositionCorrection.y || 0),
    rootObject.position.z + (rootPositionCorrection.z || 0)
  );
}

function formatTransformArray(array) {
  return array.map((v) => (typeof v === 'number' ? v.toFixed(3) : v)).join(', ');
}

function logObjectTransform(object, label) {
  if (!object) return;
  const worldPos = new THREE.Vector3();
  object.getWorldPosition(worldPos);
  console.log(`${label}: name='${object.name || '(unnamed)'}', position=[${formatTransformArray(object.position.toArray())}], rotation=[${formatTransformArray(object.rotation.toArray())}], scale=[${formatTransformArray(object.scale.toArray())}], worldPos=[${formatTransformArray(worldPos.toArray())}]`);
}

function logParentChain(meshName) {
  if (!loadedModel) return;
  const mesh = loadedModel.getObjectByName(meshName, true);
  if (!mesh) {
    console.warn(`Parent chain debug: could not find mesh named '${meshName}'`);
    return;
  }

  console.group(`Parent chain for ${meshName}`);
  let current = mesh.parent;
  while (current) {
    const parentName = current.name || '(unnamed)';
    const worldPos = new THREE.Vector3();
    current.getWorldPosition(worldPos);
    console.log(`- ${parentName}: position=[${formatTransformArray(current.position.toArray())}], rotation=[${formatTransformArray(current.rotation.toArray())}], scale=[${formatTransformArray(current.scale.toArray())}], worldPos=[${formatTransformArray(worldPos.toArray())}]`);
    current = current.parent;
  }
  console.groupEnd();
}

function logParentChains(names) {
  if (!Array.isArray(names)) return;
  names.forEach((name) => logParentChain(name));
}

function applyMeshCorrections() {
  if (!loadedModel) return;
  loadedModel.traverse((child) => {
    if (!child.isMesh) return;
    const correction = meshCorrections[child.name];
    if (!correction) return;
    if (!child.userData.originalRotation) {
      child.userData.originalRotation = child.rotation.clone();
    }
    if (!child.userData.originalPosition) {
      child.userData.originalPosition = child.position.clone();
    }
    const origRot = child.userData.originalRotation;
    const origPos = child.userData.originalPosition;
    child.rotation.set(
      origRot.x + (correction.rotationOffsetX || 0),
      origRot.y + (correction.rotationOffsetY || 0),
      origRot.z + (correction.rotationOffsetZ || 0)
    );
    child.position.set(
      origPos.x + (correction.positionOffsetX || 0),
      origPos.y + (correction.positionOffsetY || 0),
      origPos.z + (correction.positionOffsetZ || 0)
    );
  });
}

function logMeshWorldPositions(names) {
  if (!loadedModel) return;
  const center = new THREE.Vector3();
  group.getWorldPosition(center);
  console.group('World position debug');
  console.log('Eye center world position:', center);
  loadedModel.traverse((child) => {
    if (!child.isMesh) return;
    if (!names.includes(child.name)) return;
    const worldPos = new THREE.Vector3();
    child.getWorldPosition(worldPos);
    console.log(`${child.name} world position:`, worldPos);
  });
  console.groupEnd();
}

// Expose to the console for quick testing
window.meshCorrections = meshCorrections;
window.applyMeshCorrections = applyMeshCorrections;
window.logMeshWorldPositions = logMeshWorldPositions;

// Dissect sequence system (guided steps). Steps may be set via `setDissectSteps()`.
let dissectSteps = [];
let currentDissectIndex = -1;
let mode = 'explore'; // 'explore' or 'dissect'

// store highlighted originals so we can restore
function clearHighlights() {
  if (!loadedModel) return;
  loadedModel.traverse((child) => {
    if (!child.isMesh) return;
    if (child.userData.originalEmissive) {
      if (child.material && child.material.emissive) {
        child.material.emissive.copy(child.userData.originalEmissive);
        child.material.needsUpdate = true;
      }
      delete child.userData.originalEmissive;
    }
  });
}

function setDissectSteps(steps) {
  dissectSteps = Array.isArray(steps) ? steps.slice(0, 100) : [];
  currentDissectIndex = -1;
  const progressEl = document.getElementById('dissectProgress');
  if (progressEl) progressEl.textContent = `Step 0 / ${dissectSteps.length}`;
}

function applyDissectStep(index) {
  if (!loadedModel) return;
  if (index < 0 || index >= dissectSteps.length) return;
  const step = dissectSteps[index];
  // restore any previous highlights first
  clearHighlights();

  loadedModel.traverse((child) => {
    if (!child.isMesh) return;
    const name = child.name;
    if (Array.isArray(step.show) && step.show.includes(name)) child.visible = true;
    if (Array.isArray(step.hide) && step.hide.includes(name)) child.visible = false;
    if (Array.isArray(step.highlight) && step.highlight.includes(name)) {
      if (child.material && child.material.emissive) {
        child.userData.originalEmissive = child.material.emissive.clone();
        child.material.emissive.setHex(0xffea61);
        child.material.needsUpdate = true;
      }
    }
    if (Array.isArray(step.animate) && step.animate.includes(name)) {
      // simple pulse animation: scale up slightly (one-time)
      child.scale.multiplyScalar(1.02);
    }
  });
  const titleEl = document.getElementById('dissectTitle');
  const descEl = document.getElementById('dissectDesc');
  const progressEl = document.getElementById('dissectProgress');
  if (titleEl) titleEl.textContent = step.title || `Step ${index + 1}`;
  if (descEl) descEl.textContent = `${step.instruction || ''}\n\n${step.description || ''}`.trim();
  if (progressEl) progressEl.textContent = `Step ${index + 1} / ${dissectSteps.length}`;

  // handle split view during this step
  if (step.enableSplit) {
    // ensure clippingPlane exists
    if (clippingPlane) {
      updateClippingPlane(typeof step.splitFraction === 'number' ? step.splitFraction : 0.5, true);
    }
  } else {
    // disable clipping for dissect steps that don't ask for it
    materialClippingTargets.forEach((material) => {
      material.clippingPlanes = [];
      material.needsUpdate = true;
    });
    if (incisionValue) incisionValue.textContent = '0%';
  }
}

function startDissect() {
  if (!dissectSteps.length) return;
  currentDissectIndex = 0;
  applyDissectStep(currentDissectIndex);
}

function advanceDissect() {
  if (currentDissectIndex < 0) return startDissect();
  currentDissectIndex++;
  if (currentDissectIndex >= dissectSteps.length) {
    document.querySelector('.callout').innerHTML = '<strong>Dissect:</strong> Completed.';
    currentDissectIndex = dissectSteps.length - 1;
    return;
  }
  applyDissectStep(currentDissectIndex);
}

window.setDissectSteps = setDissectSteps;
window.startDissect = startDissect;
window.advanceDissect = advanceDissect;

// Default 10-step guided dissection (placeholders; will be replaced by exact steps)
const defaultDissectSteps = [
  {
    title: '1 — External Overview',
    instruction: 'Observe the eye surface and identify primary external structures.',
    description: 'Look at sclera and surrounding tissue.',
    show: ['front_fat', 'back_fat', 'sclera'],
    hide: [],
    highlight: ['sclera']
  },
  {
    title: '2 — Positioning',
    instruction: 'Orient the specimen for dissection.',
    description: 'Ensure the cornea faces forward.',
    show: ['cornea', 'iris', 'lens'],
    hide: [],
    highlight: ['cornea']
  },
  {
    title: '3 — Split the Eye',
    instruction: 'Use the split view to slice through the sclera.',
    description: 'This cross-section reveals inner chambers.',
    show: [],
    hide: ['front_fat', 'back_fat'],
    enableSplit: true,
    splitFraction: 0.4
  },
  {
    title: '4 — Cornea Removal',
    instruction: 'Expose the anterior chamber by removing the cornea.',
    description: 'Carefully note the iris location.',
    show: ['iris'],
    hide: ['cornea'],
    highlight: ['iris']
  },
  {
    title: '5 — Lens Inspection',
    instruction: 'Inspect the lens and its position relative to the iris.',
    description: 'Observe lens curvature and attachments.',
    show: ['lens'],
    hide: [],
    highlight: ['lens']
  },
  {
    title: '6 — Interior Access',
    instruction: 'Gain access to the vitreous.',
    description: 'Remove obstructing tissues.',
    show: ['vitreous'],
    hide: ['iris'],
    highlight: ['vitreous']
  },
  {
    title: '7 — Retina Exposure',
    instruction: 'Reveal the retina and tapetum.',
    description: 'Note retinal layering and reflective tapetum.',
    show: ['retina', 'tapetum'],
    hide: [],
    highlight: ['retina']
  },
  {
    title: '8 — Optic Nerve',
    instruction: 'Trace the optic nerve from the back of the eye.',
    description: 'Observe the nerve exit point.',
    show: ['optic_nerve'],
    hide: [],
    highlight: ['optic_nerve']
  },
  {
    title: '9 — Interior Review',
    instruction: 'Review key internal structures before finishing.',
    description: 'Ensure you can identify all labeled parts.',
    show: ['retina', 'vitreous', 'lens'],
    hide: [],
    highlight: []
  },
  {
    title: '10 — Complete',
    instruction: 'Finish the dissection and reset the view.',
    description: 'You have completed the guided dissection.',
    show: [],
    hide: [],
    highlight: []
  }
];

function prepareMeshMaterial(material) {
  if (Array.isArray(material)) {
    return material.map((entry) => prepareMeshMaterial(entry));
  }

  const params = {
    side: material.side,
    opacity: material.opacity,
    transparent: material.transparent,
    alphaTest: material.alphaTest,
    visible: material.visible,
    clippingPlanes: material.clippingPlanes,
    color: material.color ? material.color.clone() : new THREE.Color(0xffffff),
    map: material.map || null,
    normalMap: material.normalMap || null,
    roughnessMap: material.roughnessMap || null,
    metalnessMap: material.metalnessMap || null,
    aoMap: material.aoMap || null,
    emissiveMap: material.emissiveMap || null,
    displacementMap: material.displacementMap || null,
    alphaMap: material.alphaMap || null,
    envMap: material.envMap || null,
    emissive: material.emissive ? material.emissive.clone() : new THREE.Color(0x000000),
    roughness: material.roughness !== undefined ? material.roughness : 0.5,
    metalness: material.metalness !== undefined ? material.metalness : 0.0
  };

  const standardMaterial = new THREE.MeshStandardMaterial(params);
  standardMaterial.clippingPlanes = clippingPlane ? [clippingPlane] : [];
  standardMaterial.clipShadows = true;
  standardMaterial.needsUpdate = true;
  materialClippingTargets.push(standardMaterial);
  return standardMaterial;
}

function createClippingPlane(minZ, maxZ) {
  clippingPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -maxZ);
  cutBounds = { min: minZ, max: maxZ };
  updateClippingPlane(0, false);
}

function updateClippingPlane(fraction, updateSlider = true) {
  if (!clippingPlane || !cutBounds) return;

  cutFraction = THREE.MathUtils.clamp(fraction, 0, 1);
  const z = THREE.MathUtils.lerp(cutBounds.min, cutBounds.max, cutFraction);

  group.getWorldQuaternion(tempQuat);
  worldNormal.set(0, 0, 1).applyQuaternion(tempQuat).normalize();
  group.getWorldPosition(worldPosition);
  worldPoint.set(0, 0, z).applyQuaternion(tempQuat).add(worldPosition);

  clippingPlane.setFromNormalAndCoplanarPoint(worldNormal, worldPoint);

  materialClippingTargets.forEach((material) => {
    material.clippingPlanes = [clippingPlane];
    material.needsUpdate = true;
  });

  if (incisionValue) {
    incisionValue.textContent = `${Math.round(cutFraction * 100)}%`;
  }
  if (updateSlider && cutSlider) {
    cutSlider.value = String(Math.round(cutFraction * 100));
  }
}

function frameModel(sceneObject) {
  const box = new THREE.Box3().setFromObject(sceneObject);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  sceneObject.position.sub(center);

  createClippingPlane(box.min.z, box.max.z);

  const maxSize = Math.max(size.x, size.y, size.z);
  const fov = THREE.MathUtils.degToRad(camera.fov);
  const distance = maxSize / (2 * Math.tan(fov / 2)) * 2.0;

  camera.position.set(0, 0, distance);
  camera.near = Math.max(0.01, distance * 0.01);
  camera.far = Math.max(distance * 50, 100);
  camera.lookAt(new THREE.Vector3(0, 0, 0));
  camera.updateProjectionMatrix();
}

loader.load(
  './assets/cow-eye-fixed-textures.glb',
  (gltf) => {
    loadedModel = gltf.scene;
    loadedModel.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
        child.material = prepareMeshMaterial(child.material);
        if (interactableNames.has(child.name)) {
          child.userData.structureName = child.name;
          child.userData.isContext = !probeTargets.has(child.name);
        }
      }
    });
    if (!loadedModel.name) {
      loadedModel.name = 'modelRoot';
    }
    group.add(loadedModel);
    frameModel(loadedModel);
    // Re-apply any manual mesh corrections after the model has been framed
    // Log local position of retina before applying meshCorrections
    const retinaLocalBefore = loadedModel.getObjectByName('retina', true);
    if (retinaLocalBefore) {
      console.log('retina local position BEFORE corrections:', retinaLocalBefore.position.toArray().map((v) => v.toFixed(3)));
    }
    applyMeshCorrections();
    // Log local position of retina after applying meshCorrections
    const retinaLocalAfter = loadedModel.getObjectByName('retina', true);
    if (retinaLocalAfter) {
      console.log('retina local position AFTER corrections:', retinaLocalAfter.position.toArray().map((v) => v.toFixed(3)));
    }
    const retinaMesh = loadedModel.getObjectByName('retina', true);
    if (retinaMesh) {
      const worldPos = new THREE.Vector3();
      retinaMesh.getWorldPosition(worldPos);
      const [rx, ry, rz] = worldPos.toArray();
      console.log(`retina world X: ${rx.toFixed(3)} Y: ${ry.toFixed(3)} Z: ${rz.toFixed(3)}`);
    }
    // Log any meshes with names matching retina/tapetum so we can confirm targets
    const matching = [];
    loadedModel.traverse((child) => {
      if (!child.isMesh) return;
      const name = child.name || '';
      if (/retina|tapetum/i.test(name)) {
        matching.push(name);
        console.log('matched mesh name:', name, child);
      }
    });
    console.log('matched meshes summary:', matching);
    // Final retina diagnostics: local position, parent name, and matrixWorld
    const retinaFinal = loadedModel.getObjectByName('retina', true);
    if (retinaFinal) {
      // ensure world matrices are up-to-date
      loadedModel.updateMatrixWorld(true);
      const localPos = retinaFinal.position.toArray().map((v) => v.toFixed(3));
      const parentName = (retinaFinal.parent && retinaFinal.parent.name) || '(no parent)';
      const mw = retinaFinal.matrixWorld.elements.map((v) => v.toFixed(3));
      console.log('retina.position (local):', localPos);
      console.log('retina.parent.name:', parentName);
      console.log('retina.matrixWorld:', mw);
    }
    const tapetumMesh = loadedModel.getObjectByName('tapetum', true);
    if (tapetumMesh) {
      const worldPosTap = new THREE.Vector3();
      tapetumMesh.getWorldPosition(worldPosTap);
      const [tx, ty, tz] = worldPosTap.toArray();
      console.log(`tapetum world X: ${tx.toFixed(3)} Y: ${ty.toFixed(3)} Z: ${tz.toFixed(3)}`);
    }
    // populate default dissect steps so Dissect mode is immediately usable
    setDissectSteps(defaultDissectSteps);
  },
  undefined,
  (error) => {
    console.error('Failed to load GLTF model:', error);
    document.querySelector('.callout').innerHTML = '<strong>Error:</strong> could not load cow-eye-fixed-textures.glb';
  }
);

const controls = document.querySelectorAll('.control-btn');
controls.forEach((button) => {
  button.addEventListener('click', () => {
    // determine clicked button's tool without assuming it changes the global mode
    const tool = button.dataset.tool;
    controls.forEach((other) => other.classList.remove('active'));
    button.classList.add('active');
    // if the dissect tool was clicked, switch to dissect mode (guided)
    if (tool === 'dissect') {
      mode = 'dissect';
      const dissectPanel = document.querySelector('.dissect-panel');
      if (dissectPanel) dissectPanel.hidden = false;
      startDissect();
      // keep activeTool unchanged unless previously unset
      if (!activeTool) activeTool = 'rotate';
    } else {
      // tool buttons (rotate, cut, probe) set the active tool but don't
      // automatically exit dissect mode; to exit dissect explicitly use Explore Mode
      activeTool = tool;
      if (cutSlider) cutSlider.disabled = activeTool !== 'cut';
    }
    document.querySelector('.callout').innerHTML = `<strong>Current tool:</strong> ${activeTool}`;
  });
});

// Explore mode button: explicit way to exit dissect and return to free exploration
const exploreModeBtn = document.getElementById('exploreModeBtn');
if (exploreModeBtn) {
  exploreModeBtn.addEventListener('click', () => {
    mode = 'explore';
    const dissectPanel = document.querySelector('.dissect-panel');
    if (dissectPanel) dissectPanel.hidden = true;
    document.querySelector('.callout').innerHTML = `<strong>Current mode:</strong> Explore`;
  });
}

if (cutSlider) {
  cutSlider.addEventListener('input', (event) => {
    updateClippingPlane(event.target.value / 100, false);
  });
  cutSlider.disabled = true;
}
const dissectNextBtn = document.getElementById('dissectNext');
if (dissectNextBtn) {
  dissectNextBtn.addEventListener('click', () => {
    advanceDissect();
  });
}

canvas.addEventListener('pointerdown', (event) => {
  isDragging = true;
  previousX = event.clientX;
  previousY = event.clientY;
  lastClickPosition = { x: event.clientX, y: event.clientY };
  canvas.setPointerCapture(event.pointerId);
});

window.addEventListener('pointerup', (event) => {
  if (!isDragging) return;
  isDragging = false;
  const moveDistance = Math.hypot(event.clientX - lastClickPosition.x, event.clientY - lastClickPosition.y);
  if (moveDistance < 6 && activeTool !== 'rotate') {
    handleToolInteraction(event);
  }
});

canvas.addEventListener('pointermove', (event) => {
  if (!isDragging) return;
  const deltaX = event.clientX - previousX;
  const deltaY = event.clientY - previousY;
  previousX = event.clientX;
  previousY = event.clientY;

  if (activeTool === 'rotate') {
    group.rotation.y += deltaX * 0.008;
    group.rotation.x += deltaY * 0.008;
  }
});

function getTargetMesh(object) {
  let target = object;
  while (target && !interactableNames.has(target.name)) {
    target = target.parent;
  }
  return target;
}

function handleToolInteraction(event) {
  if (!loadedModel) return;
  const canvasBounds = canvas.getBoundingClientRect();
  pointer.x = ((event.clientX - canvasBounds.left) / canvasBounds.width) * 2 - 1;
  pointer.y = -((event.clientY - canvasBounds.top) / canvasBounds.height) * 2 + 1;

  raycaster.setFromCamera(pointer, camera);
  const intersects = raycaster.intersectObjects(loadedModel.children, true);
  if (!intersects.length) return;

  const hit = intersects
    .map((intersection) => ({ intersection, target: getTargetMesh(intersection.object) }))
    .find(({ target }) => target && interactableNames.has(target.name));

  if (!hit) return;
  const mesh = hit.target;
  const structureName = mesh.name;

  if (activeTool === 'probe') {
    const contextSuffix = probeTargets.has(mesh.name) ? '' : ' (context)';
    document.querySelector('.callout').innerHTML = `<strong>Probe:</strong> ${structureName}${contextSuffix}`;
    return;
  }

  if (activeTool === 'cut') {
    if (mesh.visible) {
      mesh.visible = false;
      document.querySelector('.callout').innerHTML = `<strong>Cut:</strong> ${structureName} removed.`;
    }
  }
}

function animate() {
  requestAnimationFrame(animate);
  if (clippingPlane) {
    updateClippingPlane(cutFraction, false);
  }
  renderer.render(scene, camera);
}

animate();

window.addEventListener('resize', () => {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  renderer.setSize(width, height);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
});
