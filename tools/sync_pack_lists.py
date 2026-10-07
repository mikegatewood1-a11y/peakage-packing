"""Push itemized pack lists to WooCommerce product meta (_pa_pack_list).
Input: a JSON file of Line Items rows (header + rows) exported from the
"Peak Age Product Contents" Google Sheet. Env: WC_URL, WC_CK, WC_CS."""
import json, os, sys, base64, urllib.request
VARIATION_PARENT = {3595: 3594, 3596: 3594, 3597: 3594}
rows = json.load(open(sys.argv[1]))
hdr, rows = rows[0], rows[1:]
ix = {h: i for i, h in enumerate(hdr)}
def g(r, k): return r[ix[k]] if ix[k] < len(r) else ""
packs = {}
for r in rows:
    pid = int(g(r, "Product ID"))
    q = g(r, "Qty")
    packs.setdefault(pid, []).append({
        "item": g(r, "Included Item"), "sku": g(r, "Item SKU"),
        "qty": float(q) if q not in ("", None) else None,
        "review": g(r, "Needs Review") == "Y", "note": g(r, "Notes")})
auth = "Basic " + base64.b64encode(f"{os.environ['WC_CK']}:{os.environ['WC_CS']}".encode()).decode()
def put(path, body):
    req = urllib.request.Request(os.environ["WC_URL"] + "/wp-json/wc/v3" + path, method="PUT",
        data=json.dumps(body).encode(), headers={"Authorization": auth, "Content-Type": "application/json", "User-Agent": "PeakAgePacking/1.0"})
    return json.load(urllib.request.urlopen(req))
ok = 0
for pid, items in packs.items():
    path = f"/products/{VARIATION_PARENT[pid]}/variations/{pid}" if pid in VARIATION_PARENT else f"/products/{pid}"
    res = put(path, {"meta_data": [{"key": "_pa_pack_list", "value": json.dumps(items)}]})
    stored = [m for m in res.get("meta_data", []) if m["key"] == "_pa_pack_list"]
    if stored and json.loads(stored[0]["value"]) == items: ok += 1
    else: print("NOT STORED", pid)
print(f"stored {ok}/{len(packs)}")
