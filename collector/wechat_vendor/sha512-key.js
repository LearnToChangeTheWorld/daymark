
function scanRanges(m, protection, pattern) {
  var hits = [];
  m.enumerateRanges(protection).forEach(function(range) {
    try {
      Memory.scanSync(range.base, range.size, pattern).forEach(function(hit) {
        hits.push({address: hit.address, range: range});
      });
    } catch (e) {
      send("WARN: scan skipped range @ " + range.base + ": " + e.message);
    }
  });
  return hits;
}

function findEntry(lea, rangeBase) {
  for (var b = 0; b < 8192; b++) {
    var a = lea.sub(b);
    if (a.compare(rangeBase) <= 0) break;
    try {
      if (a.sub(1).readU8() === 0xCC) return a;
    } catch (e) {
      send("WARN: entry inspection failed near " + lea + ": " + e.message);
      break;
    }
  }
  return null;
}

// At an x64 SHA-512 entry, rdx is the input block: key XOR 0x36 || 0x36*96.
function checkPad(p, pad) {
  try { var b = new Uint8Array(p.readByteArray(128)); for (var j=32;j<128;j++) if (b[j]!==pad) return null;
    var s=""; for (var k=0;k<32;k++) s+=('0'+(b[k]^pad).toString(16)).slice(-2); return s; } catch(e){ return null; }
}
var seen = Object.create(null);

function installHooks(m) {
  var kh = scanRanges(m, "r--", "22 ae 28 d7 98 2f 8a 42");
  if (!kh.length) throw new Error("SHA512 K-table not found");
  var tables = Object.create(null);
  kh.forEach(function(hit) { tables[hit.address.toString()] = true; });
  send("SHA-512 K-tables found: " + Object.keys(tables).length);

  // Mask REX.R and ModRM.reg to cover all 16 RIP-relative LEA encodings in one pass.
  var leas = scanRanges(m, "r-x", "48 8d 05 : fb ff c7");
  var entries = Object.create(null);
  var matchingXrefs = 0;
  leas.forEach(function(hit) {
    try {
      if (hit.address.add(7).compare(hit.range.base.add(hit.range.size)) > 0) return;
      var target = hit.address.add(7).add(hit.address.add(3).readS32());
      if (!tables[target.toString()]) return;
      matchingXrefs++;
      var entry = findEntry(hit.address, hit.range.base);
      if (entry) entries[entry.toString()] = entry;
      else send("WARN: entry not found for xref @ " + hit.address);
    } catch (e) {
      send("WARN: xref skipped @ " + hit.address + ": " + e.message);
    }
  });
  send("SHA-512 K-table xrefs found: " + matchingXrefs);
  if (!Object.keys(entries).length) throw new Error("SHA512 entries not found from K-table xrefs");

  var attached = 0;
  Object.keys(entries).forEach(function(address) {
    var entry = entries[address];
    try {
      Interceptor.attach(entry, {onEnter: function() {
        var ip = checkPad(this.context.rdx, 0x36);
        if (ip && !seen[ip]) { seen[ip] = true; send("KEY:" + ip); }
      }});
      attached++;
      send("sha512 entry @ " + entry + " (rva " + entry.sub(m.base) + ")");
    } catch (e) {
      send("WARN: hook failed @ " + entry + ": " + e.message);
    }
  });
  if (!attached) throw new Error("no SHA512 entries could be hooked");
  send("hooked " + attached + " SHA-512 entries; waiting for startup PBKDF2 (raw key)...");
}

var installed = false;
send("waiting for Weixin.dll...");
var moduleObserver = Process.attachModuleObserver({onAdded: function(m) {
  if (installed || m.name.toLowerCase() !== "weixin.dll") return;
  installed = true;
  try { installHooks(m); }
  catch (e) { send("ERR: " + e.message); }
}});
