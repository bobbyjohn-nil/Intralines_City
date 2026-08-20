# people/

Rider models — the "little agents" of manual §14 who walk to a stop, wait, and board, and the crowd
in §16's station view that mirrors the live waiting count.

**The budget here is not the vehicle budget, and the reason is instance count.** A bus appears a
dozen times on screen; a crowd is hundreds. At the vehicle allowance of 4,000 triangles, 300 waiting
riders would cost 1.2 million triangles for background detail, against 48,000 for your entire fleet.

A person model must therefore be **an order of magnitude leaner than a vehicle**, and drawn instanced
— which also means it cannot carry per-instance materials the way a bus does, so variation has to
come from the shader rather than from the mesh.

**The exact numbers are being set now** (see `studio/docs/design/renderer-3d.md` §4). Until they land,
drop the file here anyway — `npm run models` will report its real triangle count, size and bounding
box, which is exactly the evidence needed to set a sensible limit rather than a guessed one.

Same conventions as everywhere else: `.glb`, 1 unit = 1 metre (a person is ~1.7 m), pivot at floor
centre between the feet, and named material slots rather than a baked-in colour scheme.
