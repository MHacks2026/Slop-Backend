import { test } from "node:test";
import assert from "node:assert/strict";
import { faceIds, toMesh } from "../src/mesh.ts";
import { LinkError, parseDocumentLink } from "../src/onshape-link.ts";

const D = "30ec15dba3662a21e78432f3";
const W = "145d1bd39f70b691f78cf0e5";
const E = "398c04b437e185af0fa06608";

test("document links parse with workspace and tab, and the base URL comes from the host", () => {
  assert.deepEqual(parseDocumentLink(`https://cad.onshape.com/documents/${D}/w/${W}/e/${E}`), { baseUrl: "https://cad.onshape.com", did: D, wid: W, eid: E });
  assert.deepEqual(parseDocumentLink(`  cad.onshape.com/documents/${D}/w/${W}?renderMode=0#x `), { baseUrl: "https://cad.onshape.com", did: D, wid: W });
  assert.deepEqual(parseDocumentLink(`https://acme.onshape.com/documents/${D}`), { baseUrl: "https://acme.onshape.com", did: D });
});

test("links that cannot be built into are refused with a reason", () => {
  assert.throws(() => parseDocumentLink(`https://cad.onshape.com/documents/${D}/v/${W}/e/${E}`), /version, which is read-only/);
  assert.throws(() => parseDocumentLink(`https://evil.example.com/documents/${D}/w/${W}`), /onshape\.com/);
  assert.throws(() => parseDocumentLink(`https://onshape.com.evil.example/documents/${D}`), LinkError);
  assert.throws(() => parseDocumentLink(`http://cad.onshape.com/documents/${D}`), /https/);
  assert.throws(() => parseDocumentLink("https://cad.onshape.com/signin"), /does not point to a document/);
  assert.throws(() => parseDocumentLink(""), /Paste the link/);
});

const decode = (b64: string) => new Float32Array(new Uint8Array(Buffer.from(b64, "base64")).buffer);
const v = (x: number, y: number, z: number) => ({ btType: "BTVector3d-389", x, y, z });

test("index-table tessellation becomes per-face Float32 triangles with a bounding box", () => {
  const raw = {
    facetPoints: [v(0, 0, 0), v(1, 0, 0), v(0, 1, 0), v(0, 0, 2)],
    bodies: [
      {
        id: "JHD",
        name: "Part 1",
        bodyType: "SOLID",
        facetPoints: [],
        faces: [
          { id: "JcG", facets: [{ indices: [0, 1, 2], normals: [v(0, 0, 1), v(0, 0, 1), v(0, 0, 1)], vertices: [], normal: null }] },
          { id: "JcK", facets: [{ indices: [0, 2, 3], normals: [], vertices: [], normal: null }] },
        ],
      },
      { id: "S1", name: "Surface", bodyType: "SHEET", faces: [{ id: "x", facets: [{ indices: [0, 1, 2] }] }] },
    ],
  };
  const mesh = toMesh(raw);
  assert.equal(mesh.bodies.length, 1, "sheet bodies are not drawn");
  assert.deepEqual(faceIds(mesh), ["JcG", "JcK"]);
  assert.equal(mesh.triangles, 2);
  assert.deepEqual(mesh.bbox, { min: [0, 0, 0], max: [1, 1, 2] });
  assert.deepEqual([...decode(mesh.bodies[0]!.faces[0]!.positions)], [0, 0, 0, 1, 0, 0, 0, 1, 0]);
  // No vertex normals: the facet normal is computed from the winding (x = 0 plane, +x here).
  assert.deepEqual([...decode(mesh.bodies[0]!.faces[1]!.normals)].slice(0, 3), [1, 0, 0]);
});

test("the older per-facet vertices form is read too, and an empty part is an empty mesh", () => {
  const mesh = toMesh([{ id: "B", name: "P", faces: [{ id: "F", facets: [{ vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], normal: [0, 0, 1] }] }] }]);
  assert.equal(mesh.triangles, 1);
  assert.deepEqual([...decode(mesh.bodies[0]!.faces[0]!.normals)], [0, 0, 1, 0, 0, 1, 0, 0, 1]);
  assert.deepEqual(toMesh({ facetPoints: [], bodies: [] }), { bodies: [], triangles: 0 });
});
