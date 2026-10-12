import importlib.util,pathlib,unittest,time,os,signal
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('private_runner',pathlib.Path(__file__).with_name('runner.py'));r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
class Guards(unittest.TestCase):
 def cfg(self): return {'executionAuthorized':True,'productSource':r.PRODUCT,'slotId':'owned','consoleUser':'mike','startEpoch':1,'endEpoch':1000,'manifestSha256':'a'*64,'electronSha256':'b'*64,'censusSha256':'c'*64,'nodeSha256':'d'*64,'electron':'/private/tmp/sdk/Electron','census':'/private/tmp/census','node':'/opt/homebrew/bin/node','electronVersion':'42.0.1'}
 def test_valid(self): r.validate_admission(self.cfg(),10)
 def test_refuse_unadmitted(self):
  for key,value in [('executionAuthorized',False),('productSource','wrong'),('consoleUser','root')]:
   a=self.cfg();a[key]=value
   with self.assertRaises(ValueError):r.validate_admission(a,10)
 def test_slot(self):
  for now in [0,881,1001]:
   with self.assertRaises(ValueError):r.validate_admission(self.cfg(),now)
 def test_missing_pin(self):
  a=self.cfg();del a['electronSha256']
  with self.assertRaises(ValueError):r.validate_admission(a,10)
 def test_installed_sdk_refused(self):
  a=self.cfg();a['electron']='/Applications/Surf Ace.app/Contents/MacOS/Electron'
  with self.assertRaises(ValueError):r.validate_admission(a,10)
 def test_final_budget(self):
  self.assertEqual(r.remaining(75,0),60)
  for now in [51,60,75]:
   with self.assertRaises(ValueError):r.remaining(75,now)
 def good_census(self):return {'nonce':'n','runtimeQualified':True,'clear':True,'observedEpoch':10,'conflicts':[],'ownedRemaining':[]}
 def test_current_census(self):r.census_receipt(self.good_census(),'n',11)
 def test_census_identity(self):
  for key,value in [('nonce','wrong'),('runtimeQualified',False),('clear',False),('conflicts',[1]),('ownedRemaining',[2]),('observedEpoch',1)]:
   a=self.good_census();a[key]=value
   with self.assertRaises(ValueError):r.census_receipt(a,'n',11)
 def test_no_group_signal_after_reap(self):
  events=[]
  class P:
   pid=666
   def wait(self,timeout):events.append('wait');return 0
  def sig(pid,s):self.assertNotIn('wait',events);self.assertEqual(pid,666);events.append(s)
  with patch.object(r,'leader_exited',return_value=True),patch.object(r.os,'getpgid',return_value=666),patch.object(r.os,'killpg',side_effect=sig),patch.object(r.time,'monotonic',return_value=5):
   self.assertEqual(r.control_group(P(),5),(0,True))
  self.assertEqual(events,[signal.SIGTERM,signal.SIGKILL,'wait'])
 def test_unowned_group_refuses_signals(self):
  class P:pid=666
  with patch.object(r,'leader_exited',return_value=True),patch.object(r.os,'getpgid',return_value=777),patch.object(r.os,'killpg') as kill,patch.object(r.time,'monotonic',return_value=5):
   with self.assertRaises(ValueError):r.control_group(P(),5)
   kill.assert_not_called()
if __name__=='__main__':unittest.main()
