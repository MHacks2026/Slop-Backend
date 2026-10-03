/**
 * Decode the `result` of `POST .../featurescript`, which wraps every value
 * in a BTFSValue* object, into plain JS values.
 *
 *   BTFSValueNumber-772      {value}
 *   BTFSValueWithUnits-1817  {value, unitToPower}   -> number (SI)
 *   BTFSValueString-1422     {value}
 *   BTFSValueBoolean-1195    {value}
 *   BTFSValueUndefined-2037  -> undefined
 *   BTFSValueArray-1499      {value: [...]}
 *   BTFSValueMap-2077        {value: [{key, value}, ...]}
 *
 * Matching is by prefix so a bumped class id does not break decoding.
 */
export function decodeFsValue(v: unknown): unknown {
  if (!isRecord(v) || typeof v.btType !== "string") return v;
  const t = v.btType;
  if (t.startsWith("BTFSValueUndefined")) return undefined;
  if (t.startsWith("BTFSValueArray")) return (asArray(v.value)).map(decodeFsValue);
  if (t.startsWith("BTFSValueMap")) {
    const out: Record<string, unknown> = {};
    for (const entry of asArray(v.value)) {
      if (!isRecord(entry)) continue;
      out[String(decodeFsValue(entry.key))] = decodeFsValue(entry.value);
    }
    return out;
  }
  if ("value" in v) return v.value;
  return v;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
