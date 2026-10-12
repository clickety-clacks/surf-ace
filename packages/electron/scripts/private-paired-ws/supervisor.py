"""Owned live session anchor: Node may exit; anchor remains until parent cleanup."""
import argparse,json,os,pathlib,select,signal,subprocess,sys,time

def publish(path,value):
    temp=path.with_name(path.name+'.pending')
    with temp.open('x') as f: json.dump(value,f);f.flush();os.fsync(f.fileno())
    temp.replace(path)

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--receipt',required=True);parser.add_argument('--hold-seconds',type=float,required=True);parser.add_argument('command',nargs=argparse.REMAINDER)
    args=parser.parse_args();pid=os.getpid()
    if not sys.flags.isolated or os.getpgid(pid)!=pid or not 0<args.hold_seconds<=65 or not args.command: raise ValueError('unowned/invalid anchor')
    # Caught (not SIG_IGN): exec resets this handler for the Node child. Anchor
    # survives the parent's TERM and remains live through its final group KILL.
    signal.signal(signal.SIGTERM,lambda *_:None)
    deadline=time.monotonic()+args.hold_seconds
    child=subprocess.Popen(args.command)
    receipt=pathlib.Path(args.receipt)
    try:
        while time.monotonic()<deadline:
            code=child.poll()
            if code is not None:
                publish(receipt,dict(childPID=child.pid,childExit=code,anchorPID=pid,pgid=pid))
                break
            if select.select([0],[],[],.02)[0] and not os.read(0,1): break
        # Remain alive even after child completion; parent owns the cleanup turn.
        while time.monotonic()<deadline:
            if select.select([0],[],[],min(.02,max(0,deadline-time.monotonic())))[0] and not os.read(0,1): break
    finally:
        # EOF/parent death/own watchdog: same still-live session owner, never a
        # discovered or saved foreign PGID. It survives TERM until its own KILL.
        if os.getpgid(os.getpid())!=pid: raise ValueError('anchor identity lost')
        os.killpg(pid,signal.SIGTERM);time.sleep(.1)
        if os.getpgid(os.getpid())!=pid: raise ValueError('anchor identity lost before final signal')
        os.killpg(pid,signal.SIGKILL)

if __name__=='__main__':main()
