// Ponto de entrada da cena do escritório.
export type {
  SceneRoom, SceneWorker, ScenePlayer, SceneOptions, SceneSelection, SceneInteractable, SceneHandlers, OfficeScene, CameraMode, MinimapData,
  SceneMeeting, SceneMeetingActor,
} from './types';
export { createOfficeScene } from './office';
export { OfficeCanvas } from './OfficeCanvas';
export type { OfficeCanvasProps, SceneFocus } from './OfficeCanvas';
export { poseForPhase, phaseLabel, ALL_PHASES } from './poses';
export type { Pose } from './poses';
export {
  ROOM_SLOTS, MEETING_SLOT, MEETING_COLOR, MEETING_LABEL, GRID_W, GRID_H, WORLD_W, WORLD_H, PLAYER_START, ENTRANCE, LOUNGE_SPOTS,
  getRoomRect, getRoomSlot, getDeskPositions, getRoomDoor, getMeetingSeats, getMeetingTableRect,
  buildLayout, validateLayout, roomCenterTile, roomCenterPx, slotAtTile,
} from './layout';
export type { OfficeLayout, Prop, Light, Tile, Rect, MeetingSeat, Facing } from './layout';
export { findPath, nearestWalkable } from './pathfinding';
export {
  fitZoomFor, fitCameraFor, clampCameraTo, followCamera, visibleWorldRect, cameraCenteredOn, usableRect, smoothTowards, clampZoom,
  ZOOM_MIN, ZOOM_MAX, FIT_MARGIN, NO_INSETS,
} from './camera';
export type { Insets } from './camera';
export {
  stepPlayer, stepAlongPath, moveVector, dirFromVector, safePlayerPosition, canStand, tileOfPoint, tileToPlayerPos, distanceToTileRect,
  PLAYER_SPEED, INTERACT_REACH,
} from './player';
export type { PlayerInput, Vec, Dir } from './player';
export { TILE, CHAR_W, CHAR_H, SPRITES, characterPalette } from './sprites';
