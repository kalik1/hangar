# Renders the records agent.sh gathered as the inventory JSON, with names
# from pci.ids and usb.ids. Records are fields separated by \037; the
# first field is the kind (see agent.sh gather_records).
# Usage: awk -F'\037' -v rec=RECORDS -f render.awk RECORDS pci.ids usb.ids

function join(s, sep, rep, n, i, a, out) {
  n = split(s, a, sep)
  out = a[1]
  for (i = 2; i <= n; i++) out = out rep a[i]
  return out
}
# JSON string. Concatenation only: gsub replacement escapes differ between awks.
function q(s) {
  s = join(s, "\\", "\\\\")
  s = join(s, "\"", "\\\"")
  gsub(/\t/, " ", s)
  return "\"" s "\""
}
function qn(s) { return s == "" ? "null" : q(s) }
function num(s) { return s ~ /^-?[0-9]+$/ ? sprintf("%.0f", s + 0) : "null" }
function bool(s) { return s == "1" ? "true" : "false" }
function arr(s, n, i, a, out) {
  if (s == "") return "[]"
  n = split(s, a, ",")
  out = "["
  for (i = 1; i <= n; i++) if (a[i] != "") out = out (out == "[" ? "" : ",") q(a[i])
  return out "]"
}
function cls2(c) { return substr(c, 1, 2) }
function cls4(c) { return substr(c, 1, 4) }

FILENAME == rec {
  k = $1
  if (k == "K") { meta[$2] = $3; next }
  if (k == "P") {
    P[np++] = $0
    wantV[$4] = 1; wantV[$6] = 1
    wantD[$4 ":" $5] = 1
    wantS[$4 ":" $5 ":" $6 ":" $7] = 1
    wantC[cls2($3)] = 1; wantSC[cls4($3)] = 1
    next
  }
  if (k == "M") { M[nm++] = $0; next }
  if (k == "D") { D[nd++] = $0; next }
  if (k == "U") {
    U[nu++] = $0
    wantUV[$5] = 1; wantUP[$5 ":" $6] = 1; wantUC[$11] = 1
    n = split($12, ic, ",")
    for (i = 1; i <= n; i++) wantUC[ic[i]] = 1
    next
  }
  if (k == "B") { B[nb++] = $0; next }
  if (k == "H") { needs[$2] = $3; next }
  if (k == "G") { groupVm[$2] = $3; next }
  if (k == "V") { usbVm[$2 ":" $3] = $4; next }
  if (k == "S") { stState[$2] = $3; stMsg[$2] = $4; next }
  if (k == "W") { desired[$2] = 1; next }
  if (k == "X") { managed[$2] = 1; next }
  next
}

FILENAME ~ /pci\.ids$/ {
  line = $0
  if (line == "" || line ~ /^#/) next
  if (line ~ /^C /) { pc = substr(line, 3, 2); inC = 1; if (pc in wantC) pciClass[pc] = substr(line, 7); next }
  if (inC) {
    if (line ~ /^\t\t/) next
    if (line ~ /^\t/) { sc = pc substr(line, 2, 2); if (sc in wantSC) pciSub[sc] = substr(line, 6); next }
  }
  if (line ~ /^[0-9a-f][0-9a-f][0-9a-f][0-9a-f] /) { inC = 0; pv = substr(line, 1, 4); if (pv in wantV) pciVen[pv] = substr(line, 7); next }
  if (line ~ /^\t\t[0-9a-f][0-9a-f][0-9a-f][0-9a-f] [0-9a-f][0-9a-f][0-9a-f][0-9a-f] /) {
    key = pv ":" pd ":" substr(line, 3, 4) ":" substr(line, 8, 4)
    if (key in wantS) pciSubsys[key] = substr(line, 14)
    next
  }
  if (line ~ /^\t[0-9a-f][0-9a-f][0-9a-f][0-9a-f] /) { pd = substr(line, 2, 4); key = pv ":" pd; if (key in wantD) pciDev[key] = substr(line, 8); next }
  next
}

FILENAME ~ /usb\.ids$/ {
  line = $0
  if (line == "" || line ~ /^#/) next
  if (line ~ /^C /) { uDone = 1; uc = substr(line, 3, 2); if (uc in wantUC) usbClass[uc] = substr(line, 7); next }
  if (line ~ /^[A-Z]/) { uDone = 1; next }
  if (uDone) next
  if (line ~ /^[0-9a-f][0-9a-f][0-9a-f][0-9a-f] /) { uv = substr(line, 1, 4); if (uv in wantUV) usbVen[uv] = substr(line, 7); next }
  if (line ~ /^\t[0-9a-f][0-9a-f][0-9a-f][0-9a-f] /) { key = uv ":" substr(line, 2, 4); if (key in wantUP) usbProd[key] = substr(line, 8); next }
  next
}

END {
  printf "{\"node\":%s,\"agent\":%s,\"generated\":%s,\"kernel\":%s,\"cmdline\":%s,", q(meta["node"]), q(meta["agent"]), q(meta["generated"]), q(meta["kernel"]), q(meta["cmdline"])
  printf "\"iommuGroups\":%s,\"vfioLoaded\":%s,\"lastBind\":%s,", num(meta["iommuGroups"]), bool(meta["vfio"]), num(meta["lastBind"])

  # mediated device types per parent
  for (i = 0; i < nm; i++) {
    split(M[i], f, FS)
    e = "{\"id\":" q(f[3]) ",\"name\":" q(f[4]) ",\"available\":" num(f[5]) ",\"api\":" q(f[6]) ",\"description\":" q(f[7]) "}"
    mt[f[2]] = (f[2] in mt) ? mt[f[2]] "," e : e
  }

  printf "\"pci\":["
  for (i = 0; i < np; i++) {
    split(P[i], f, FS)
    a = f[2]; c = f[3]; v = f[4]; d = f[5]; sv = f[6]; sd = f[7]; g = f[11]
    st = (a in stState) ? "{\"state\":" q(stState[a]) ",\"message\":" q(stMsg[a]) "}" : "null"
    used = (g != "" && (g in groupVm)) ? q(groupVm[g]) : "null"
    printf "%s{\"address\":%s,\"class\":%s,\"className\":%s,\"subclassName\":%s,", (i ? "," : ""), q(a), q(c), qn(pciClass[cls2(c)]), qn(pciSub[cls4(c)])
    printf "\"vendor\":%s,\"device\":%s,\"vendorName\":%s,\"deviceName\":%s,", q(v), q(d), qn(pciVen[v]), qn(pciDev[v ":" d])
    printf "\"subsystemVendor\":%s,\"subsystemDevice\":%s,\"subsystemVendorName\":%s,\"subsystemName\":%s,", q(sv), q(sd), qn(pciVen[sv]), qn(pciSubsys[v ":" d ":" sv ":" sd])
    printf "\"revision\":%s,\"driver\":%s,\"driverOverride\":%s,\"iommuGroup\":%s,\"numaNode\":%s,", q(f[8]), qn(f[9]), qn(f[10]), qn(g), num(f[12])
    printf "\"sriovTotalVfs\":%s,\"sriovNumVfs\":%s,\"physfn\":%s,\"bootVga\":%s,\"parent\":%s,", num(f[13]), num(f[14]), qn(f[15]), bool(f[16]), qn(f[17])
    printf "\"hostNeeds\":%s,\"usedBy\":%s,\"desired\":%s,\"managed\":%s,\"binder\":%s,", qn(needs[a]), used, (a in desired) ? "true" : "false", (a in managed) ? "true" : "false", st
    printf "\"mdevTypes\":[%s]}", (a in mt) ? mt[a] : ""
  }
  printf "],\"mdevs\":["
  for (i = 0; i < nd; i++) {
    split(D[i], f, FS)
    used = (f[5] != "" && (f[5] in groupVm)) ? q(groupVm[f[5]]) : "null"
    printf "%s{\"uuid\":%s,\"parent\":%s,\"type\":%s,\"iommuGroup\":%s,\"usedBy\":%s}", (i ? "," : ""), q(f[2]), qn(f[3]), qn(f[4]), qn(f[5]), used
  }
  printf "],\"usb\":["
  for (i = 0; i < nu; i++) {
    split(U[i], f, FS)
    v = f[5]; p = f[6]
    vn = (v in usbVen) ? usbVen[v] : f[7]
    pn = ((v ":" p) in usbProd) ? usbProd[v ":" p] : f[8]
    n = split(f[12], ic, ",")
    icn = ""
    for (j = 1; j <= n; j++) if (ic[j] in usbClass) icn = icn (icn == "" ? "" : ",") usbClass[ic[j]]
    k2 = (f[3] + 0) ":" (f[4] + 0)
    used = (k2 in usbVm) ? q(usbVm[k2]) : "null"
    printf "%s{\"path\":%s,\"bus\":%s,\"device\":%s,\"vendor\":%s,\"product\":%s,\"vendorName\":%s,\"productName\":%s,", (i ? "," : ""), q(f[2]), num(f[3]), num(f[4]), q(v), q(p), qn(vn), qn(pn)
    printf "\"manufacturer\":%s,\"productString\":%s,\"serial\":%s,\"speed\":%s,\"deviceClass\":%s,\"className\":%s,", qn(f[7]), qn(f[8]), qn(f[9]), qn(f[10]), qn(f[11]), qn(usbClass[f[11]])
    printf "\"interfaceClasses\":%s,\"interfaceClassNames\":%s,\"drivers\":%s,\"controller\":%s,\"usedBy\":%s}", arr(f[12]), arr(icn), arr(f[13]), qn(f[14]), used
  }
  printf "],\"disks\":["
  for (i = 0; i < nb; i++) {
    split(B[i], f, FS)
    printf "%s{\"name\":%s,\"sizeBytes\":%s,\"model\":%s,\"vendor\":%s,\"serial\":%s,\"wwid\":%s,", (i ? "," : ""), q(f[2]), num(f[3]), qn(f[4]), qn(f[5]), qn(f[6]), qn(f[7])
    printf "\"rotational\":%s,\"removable\":%s,\"byId\":%s,\"partitions\":%s,\"holders\":%s,\"mounts\":%s,", bool(f[8]), bool(f[9]), arr(f[10]), arr(f[11]), arr(f[12]), arr(f[13])
    printf "\"controller\":%s,\"transport\":%s,\"signatures\":%s,\"openBy\":%s}", qn(f[14]), q(f[15]), arr(f[16]), arr(f[17])
  }
  printf "]}\n"
}
