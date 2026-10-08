# Future Ideas

This file stores small product, UX, and rendering ideas that are worth keeping
for later, but are not important enough to interrupt current implementation
work.

## Structural Model

### Level Elevation Zones

- Add sub-level/elevation zones inside a regular level for cases such as a
  kitchen that is one step above a living room while still belonging to the same
  floor.
- Model this as a region or zone with a local elevation offset rather than as a
  full new level.
- Allow stairs to connect either two regular levels or two elevation zones
  within the same level.
- Keep this as part of the structural model because it affects floor slabs,
  wall bases, stairs, room detection, and later exports.

## Design And Materials

### Material And Texture Layer

- [x] Add the first separate material/finish layer with named base colors and
  assignments for walls, slabs, and solved roof faces.
- [x] Store the material library and surface assignments in `.wawod` files and
  consume them in the editor and detached preview renderer.
- [x] Assign finishes independently to the left and right wall faces without
  splitting or changing the structural wall geometry.
- [ ] Extend assignments to additional targets such as shapes and dedicated
  floor finishes.
- [ ] Add optional texture assets, repeat scale, rotation, and renderer-specific
  texture loading.
- Keep structural types separate from visual finishes. For example, a wall type
  should describe thickness/height, while a material assignment should describe
  plaster, brick, wood, tiles, paint, or other visible surfaces.
- [ ] Let 2D plans optionally show hatches or simple material markers only where
  useful.

### Exterior Window Blinds

- [x] Add optional exterior blinds and roller shutters as 3D window and door
  design extensions.
- Treat blinds as a design add-on attached to `WindowDesign3D`, not as a new
  structural opening.
- Useful first parameters: enabled, color, slat angle, lowered/open amount, and
  offset in front of the window.
- A first renderer can generate a simple stack of thin slats in front of the
  window frame.

## Interaction Polish

### Unified Object Actions

- [x] Add a shared 2D Move-tool menu for selecting overlapping objects, opening
  their properties, moving them or deleting them through existing commands.
- [ ] Extend the same action model to 3D objects and touch long-press interaction.
- [ ] Add an explicit Extend Surface action for slabs, rooms, ground and finishes:
  paint additional regions and union them without changing unrelated objects.

### 3D Window Opening Interaction

- Replace the current invisible 3D opening hit-box selection feel with a more
  explicit outline-style highlight when a window opening is hovered or selected.
- Keep the hit target fully non-rendering for correctness, but add a separate
  visible outline or edge overlay so the active opening is clearer without
  relying on a nearly invisible box mesh.
- Prefer an outline, frame glow, or edge-only guide instead of any filled box,
  so the opening remains easy to read and does not interfere with glass/frame
  rendering again.
