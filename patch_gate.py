import sys

p = 'index.js'
s = open(p).read()
applied, missing = [], []

def rep(tag, old, new):
    global s
    if old not in s:
        missing.append(tag)
        return
    s = s.replace(old, new, 1)
    applied.append(tag)

# ---- 1. editGate helper ----
rep('gate-helper',
"""function canManageSetup(req, id) {
  return (!MANAGE_KEY || manageSessionValid(req)) || ownerOk(req, id);
}
async function mintSetup""",
"""function canManageSetup(req, id) {
  return (!MANAGE_KEY || manageSessionValid(req)) || ownerOk(req, id);
}

// Editing gate for stored setups: admin/owner pass through freely; otherwise
// the setup's access password (supplied as ?pw=) unlocks it.
function editGate(req, id) {
  const hash = id ? accessHashFor(id) : null;
  if (canManageSetup(req, id)) return { allowed: true };
  if (hash) {
    const pw = String(req.query.pw || '');
    const supplied = sha256hex(`${id}:${pw}`);
    if (pw && supplied.length === hash.length && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(hash))) {
      return { allowed: true };
    }
    return { allowed: false, locked: true };
  }
  return { allowed: false, locked: false };
}
async function mintSetup""")

# ---- 2-5. swap guards on four routes ----
old_guard = "if (!canManageSetup(req, %s)) return res.status(401).json({ ok: false, error: 'Owner key or admin session required' });"

def gate(tag, who, varname):
    new = """const %sGate = editGate(req, %s);
  if (!%sGate.allowed) {
    if (%sGate.locked) return res.json({ ok: false, locked: true });
    return res.status(401).json({ ok: false, error: 'Owner key, admin session, or access password required' });
  }""" % (varname, varname, varname, varname)
    rep(tag, old_guard % who, new)

gate('get-skeleton', 'sid0', 'gate0')
gate('put-gate', 'old.id', 'putGate')
gate('delete-gate', 'id', 'delGate')
gate('refresh-gate', 'entry.id', 'rfGate')

open(p, 'w').write(s)
print('APPLIED:', applied)
print('MISSING:', missing)
