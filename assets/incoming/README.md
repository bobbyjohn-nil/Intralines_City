# Incoming assets

Drop 3D models here and say what they are. `modeler` imports, fixes, and wires them in.

```
assets/incoming/        drop models here
assets/incoming/<name>/ if a model has loose textures, keep them in a folder with it
```

## What to drop

**`.glb` / `.gltf` is the best format** — self-contained, correct scale, materials included. `.fbx` works.
`.blend` and `.obj` are fine. If you have a choice at export time, pick glTF.

Include the textures. If the model came as a zip with a `textures/` folder, keep them together.

## What to say

One line is enough: *"this is the player character, rigged"*, *"a crate, should be about 1m"*,
*"three rock variants for the cliff level"*.

Worth mentioning if you know it: intended real-world size, which way is forward, whether it is
rigged, and where the pivot should sit (floor? hinge? centre?). `modeler` will measure and infer
what you leave out, but guessing the pivot is where it most often guesses wrong.

## What happens

`modeler` checks scale, axis orientation, origin, materials and colorspace, and triangle count,
generates a simple collision mesh, places it in the game, and reports what it measured. Anything
genuinely broken in the source file gets named so you can re-export rather than having it quietly
worked around.

Processed files move to the project's real asset directory. This folder is an inbox, not storage.
