import { useEffect, useRef, useState } from "react";
import { useThree } from "@react-three/fiber";
import { Html, Line } from "@react-three/drei";
import * as THREE from "three";
import type { MeasurementUnit } from "../domain/project-model";

type Point3D = [number, number, number];
export interface Measurement3D { start: Point3D; end: Point3D; distanceM: number; complete: boolean; }
export function formatDistance3D(distanceM: number, unit: MeasurementUnit) {
  return `${(distanceM * (unit === "cm" ? 100 : unit === "dm" ? 10 : 1)).toFixed(2)} ${unit}`;
}

export function Measure3D({ unit, radius, onChange, onDraggingChange, clearToken = 0 }: {
  unit: MeasurementUnit; radius: number; onChange?: (measurement: Measurement3D | null) => void;
  onDraggingChange: (dragging: boolean) => void; clearToken?: number;
}) {
  const { camera, scene, gl } = useThree();
  const [measurement, setMeasurement] = useState<Measurement3D | null>(null);
  const currentRef = useRef<Measurement3D | null>(null);
  const callbacksRef = useRef({ onChange, onDraggingChange });
  callbacksRef.current = { onChange, onDraggingChange };
  const pointerRef = useRef<{ id: number; x: number; y: number } | null>(null);
  function update(next: Measurement3D | null) {
    currentRef.current = next; setMeasurement(next); callbacksRef.current.onChange?.(next);
  }
  useEffect(() => { update(null); }, [clearToken]);
  useEffect(() => {
    const canvas = gl.domElement;
    const raycaster = new THREE.Raycaster();
    function hit(event: PointerEvent): Point3D | null {
      const rect = canvas.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return null;
      raycaster.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1), camera);
      // Invisible interaction proxies must not replace the actual visible surface.
      const intersection = raycaster.intersectObjects(scene.children, true).find(({ object }) => {
        if (!(object instanceof THREE.Mesh)) return false;
        for (let parent: THREE.Object3D | null = object; parent; parent = parent.parent) {
          if (!parent.visible || parent.userData.measureIgnore) return false;
        }
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        return materials.some((material) => material.visible && material.colorWrite && material.opacity > 0);
      });
      return intersection ? intersection.point.toArray() as Point3D : null;
    }
    function move(event: PointerEvent) {
      const current = currentRef.current;
      if (!current || current.complete || (pointerRef.current && event.pointerId !== pointerRef.current.id)) return;
      const end = hit(event);
      if (end) update({ ...current, end, distanceM: new THREE.Vector3(...current.start).distanceTo(new THREE.Vector3(...end)) });
    }
    function down(event: PointerEvent) {
      if (event.button !== 0) return;
      const point = hit(event);
      if (!point) return;
      event.preventDefault(); event.stopImmediatePropagation();
      const current = currentRef.current;
      if (current && !current.complete) {
        update({ ...current, end: point, distanceM: new THREE.Vector3(...current.start).distanceTo(new THREE.Vector3(...point)), complete: true });
      } else update({ start: point, end: point, distanceM: 0, complete: false });
      pointerRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
      canvas.setPointerCapture(event.pointerId);
      callbacksRef.current.onDraggingChange(true);
    }
    function up(event: PointerEvent) {
      const pointer = pointerRef.current;
      if (!pointer || event.pointerId !== pointer.id) return;
      event.stopImmediatePropagation();
      const dragged = Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 4;
      const current = currentRef.current, end = hit(event);
      if (dragged && current && end && !current.complete) {
        update({ ...current, end, distanceM: new THREE.Vector3(...current.start).distanceTo(new THREE.Vector3(...end)), complete: true });
      }
      pointerRef.current = null;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      callbacksRef.current.onDraggingChange(false);
    }
    function cancel() { pointerRef.current = null; callbacksRef.current.onDraggingChange(false); update(null); }
    function key(event: KeyboardEvent) { if (event.key === "Escape") cancel(); }
    canvas.addEventListener("pointerdown", down, true); canvas.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true); canvas.addEventListener("pointercancel", cancel); window.addEventListener("keydown", key);
    return () => {
      canvas.removeEventListener("pointerdown", down, true); canvas.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true); canvas.removeEventListener("pointercancel", cancel); window.removeEventListener("keydown", key);
      const pointer = pointerRef.current;
      if (pointer && canvas.hasPointerCapture(pointer.id)) canvas.releasePointerCapture(pointer.id);
      pointerRef.current = null;
      callbacksRef.current.onDraggingChange(false); callbacksRef.current.onChange?.(null);
    };
  }, [camera, gl, scene]);
  if (!measurement) return null;
  const midpoint = measurement.start.map((value, index) => (value + measurement.end[index]) / 2) as Point3D;
  return <group userData={{ measureIgnore: true }}>
    {measurement.distanceM > 0.00001 ? <Line points={[measurement.start, measurement.end]} color="#ffc17b" lineWidth={2} depthTest={false} renderOrder={1000} /> : null}
    {[measurement.start, measurement.end].map((point, index) => <mesh key={index} position={point} renderOrder={1001}>
      <sphereGeometry args={[Math.max(0.015, Math.min(0.08, radius * 0.003)), 12, 8]} />
      <meshBasicMaterial color="#ffc17b" depthTest={false} />
    </mesh>)}
    <Html position={midpoint} center style={{ pointerEvents: "none" }}><span className="measurement-3d-label">{formatDistance3D(measurement.distanceM, unit)}</span></Html>
  </group>;
}
