"""Read-only Darwin census for the private scope-B runner; never sends signals."""
import argparse, ctypes, hashlib, json, math, os, pathlib, re, stat, subprocess, sys, time

def finite(v):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        raise ValueError('invalid census clock')
    return v

def parse_processes(text):
    rows = {}
    for line in text.splitlines():
        fields = line.strip().split(None, 9)
        if len(fields) != 10: raise ValueError('incomplete process row')
        pid, ppid, pgid, uid = map(int, fields[:4])
        if pid <= 0 or min(ppid, pgid, uid) < 0 or pid in rows: raise ValueError('ambiguous process row')
        rows[pid] = dict(pid=pid, ppid=ppid, pgid=pgid, uid=uid,
                         started=' '.join(fields[4:9]), argv=fields[9])
    if not rows: raise ValueError('empty process snapshot')
    return rows

def executable(pid):
    # proc_pidpath is the kernel path seam; ps comm/argv[0] is never an executable identity.
    lib = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
    lib.proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
    lib.proc_pidpath.restype = ctypes.c_int
    buf = ctypes.create_string_buffer(4096)
    if lib.proc_pidpath(pid, buf, len(buf)) <= 0: raise ValueError('unresolved executable PID ' + str(pid))
    value = os.fsdecode(buf.value)
    if not value.startswith('/') or '\n' in value: raise ValueError('invalid kernel executable path')
    return value

def command(args):
    with subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) as proc:
        try: out, err = proc.communicate(timeout=1)
        except subprocess.TimeoutExpired:
            proc.kill(); proc.communicate(); raise ValueError('OS snapshot timeout')
        if proc.returncode or err: raise ValueError('OS snapshot failed: ' + args[0])
        return out, proc.pid

def process_table(args):
    text, census_child = command(args)
    rows = parse_processes(text)
    # Exclude only this exact Popen-created snapshot child, not a name/argv match.
    rows.pop(census_child, None)
    return rows

def snapshot():
    args = ['/bin/ps', '-axo', 'pid=,ppid=,pgid=,uid=,lstart=,command=']
    before = process_table(args)
    owned = {pid: {**r, 'executable': executable(pid)} for pid, r in before.items() if r['uid'] == os.getuid()}
    after = process_table(args)
    for pid, row in owned.items():
        if after.get(pid) != before[pid]: raise ValueError('process changed during executable resolution')
        if executable(pid) != row['executable']: raise ValueError('executable changed during census')
    # New same-user processes also require resolution; no mutable-name prefilter.
    if {p for p, r in after.items() if r['uid'] == os.getuid()} != set(owned):
        raise ValueError('process set changed during census')
    return owned

def listeners():
    result = subprocess.run(['/usr/sbin/lsof', '-nP', '-a', '-u', str(os.getuid()), '-iTCP', '-sTCP:LISTEN', '-Fpn'],
                            capture_output=True, text=True, timeout=1)
    if result.returncode == 1 and not result.stdout and not result.stderr: return []
    if result.returncode or result.stderr: raise ValueError('listener snapshot failed')
    rows = []; pid = None; endpoints = 0
    for line in result.stdout.splitlines():
        if line.startswith('p'):
            if pid is not None and endpoints == 0: raise ValueError('incomplete listener owner record')
            if not line[1:].isdigit() or int(line[1:]) <= 0: raise ValueError('ambiguous listener PID')
            pid = int(line[1:]); endpoints = 0
        elif line.startswith('n'):
            if pid is None or not line[1:].strip(): raise ValueError('ambiguous listener row')
            rows.append(dict(pid=pid, endpoint=line[1:])); endpoints += 1
        else: raise ValueError('unexpected listener field')
    if pid is not None and endpoints == 0: raise ValueError('incomplete listener owner record')
    return rows

def runtime_identity(path):
    value = pathlib.PurePosixPath(path); name = value.name.lower(); parts = value.parts
    # Electron supports renamed main/helper bundles: basename alone is insufficient.
    # Treat every unapproved app-bundle executable as ambiguous, without assuming its
    # framework files on disk describe the loaded image. Exact resident exemption only.
    app_bundle = any(parts[i].lower().endswith('.app') and parts[i+1:i+3] == ('Contents', 'MacOS')
                     for i in range(len(parts)-3))
    return app_bundle or name == 'node' or name.startswith(('electron', 'python')) or name in ('xcodebuild', 'xctest')

def evaluate(rows, listen, policy, self_pid, owned_pgid=None):
    if self_pid not in rows: raise ValueError('census process absent')
    ancestors = set(); current = self_pid
    while current in rows:
        if current in ancestors: raise ValueError('ancestor cycle')
        ancestors.add(current); current = rows[current]['ppid']
    resident = policy.get('residentProcesses', [])
    if not isinstance(resident, list): raise ValueError('resident baseline missing')
    exempt = set()
    keys = {'pid', 'ppid', 'pgid', 'uid', 'started', 'argv', 'executable', 'executableSha256'}
    for item in resident:
        if not isinstance(item, dict) or set(item) != keys: raise ValueError('incomplete resident identity')
        row = rows.get(item['pid'])
        # Disappeared baseline is harmless; replacement/renamed/changed incarnation is not exempt.
        if row is not None and all(row[k] == item[k] for k in keys - {'executableSha256'}):
            actual = hashlib.sha256(pathlib.Path(row['executable']).read_bytes()).hexdigest()
            if actual != item['executableSha256']: raise ValueError('resident executable changed')
            exempt.add(item['pid'])
    remaining = sorted(p for p, r in rows.items() if owned_pgid is not None and r['pgid'] == owned_pgid)
    conflicts = []
    for pid, row in rows.items():
        if pid in ancestors or pid in exempt: continue
        runtime = runtime_identity(row['executable'])
        private = any(s in row['argv'] for s in ('private-paired-ws', 'paired-ws-B-', 'private-pane-paint', 'native-scale', 'test-pane-popout'))
        if runtime or private: conflicts.append(dict(pid=pid, executable=row['executable'], argv=row['argv']))
    for item in listen:
        if item['pid'] not in rows: raise ValueError('listener owner absent from process snapshot')
    return conflicts, remaining

def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--nonce', required=True)
    parser.add_argument('--policy', required=True); parser.add_argument('--owned-pgid', type=int)
    args = parser.parse_args(); result = dict(nonce=args.nonce, runtimeQualified=False, clear=False, conflicts=[], ownedRemaining=[])
    try:
        if sys.platform != 'darwin' or not sys.flags.isolated: raise ValueError('Darwin absolute Python -I required')
        if not re.fullmatch('[0-9a-f]{32}', args.nonce): raise ValueError('invalid nonce')
        path = pathlib.Path(args.policy); info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077: raise ValueError('untrusted policy')
        policy = json.loads(path.read_text()); now = finite(time.time())
        if not finite(policy['startEpoch']) <= now < finite(policy['endEpoch']): raise ValueError('expired policy')
        if args.owned_pgid is not None and args.owned_pgid <= 1: raise ValueError('invalid owned group')
        start = time.monotonic(); rows = snapshot(); listen = listeners()
        conflicts, remaining = evaluate(rows, listen, policy, os.getpid(), args.owned_pgid)
        if time.monotonic() - start > 2: raise ValueError('census snapshot exceeded freshness budget')
        result.update(runtimeQualified=True, clear=not conflicts and not remaining, conflicts=conflicts,
                      ownedRemaining=remaining, listeners=listen, observedEpoch=now, processCount=len(rows))
    except Exception as error: result.update(error=str(error), observedEpoch=time.time())
    print(json.dumps(result)); return 0 if result['runtimeQualified'] else 1

if __name__ == '__main__': sys.exit(main())
