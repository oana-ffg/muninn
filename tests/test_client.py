import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import uuid

spec=importlib.util.spec_from_file_location('muninn',Path(__file__).parents[1]/'scripts/muninn.py')
mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)

class ClientTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.session=str(uuid.uuid4());self.photo=str(uuid.uuid4())
        self.content=b'\xff\xd8\xffsynthetic\xff\xd9'
        self.sha=hashlib.sha256(self.content).hexdigest()
        self.client=mod.Client({'origin':'https://relay.example.test','app_token':'test-only','gateway_token':'test-only'},'host-a','chat-a')
        self.calls=[]
        self.state={'id':self.session,'environment':'host-a','thread':'chat-a','state':'done','photos':[{'id':self.photo,'sha256':self.sha,'size':len(self.content)}]}
        self.client.request=self.request
    def request(self,method,path,data=None,session=None,binary=False):
        self.calls.append((method,path))
        if binary:return self.content
        if path.endswith('/ack'):return {'state':'delivered'}
        return self.state
    def test_verified_files_then_ack_and_repeat_without_download(self):
        result=self.client.fetch(self.session,self.temp.name)
        self.assertEqual(Path(result['files'][0]).read_bytes(),self.content)
        self.assertTrue(self.calls[-1][1].endswith('/ack'))
        self.calls=[];self.state['state']='delivered'
        self.client.fetch(self.session,self.temp.name)
        self.assertFalse(any('/photos/' in path for _,path in self.calls))
    def test_corruption_never_acknowledges(self):
        self.state['photos'][0]['sha256']='0'*64
        with self.assertRaises(mod.ClientError):self.client.fetch(self.session,self.temp.name)
        self.assertFalse(any(path.endswith('/ack') for _,path in self.calls))
    def test_wrong_thread_never_downloads(self):
        self.state['thread']='other'
        with self.assertRaises(mod.ClientError):self.client.fetch(self.session,self.temp.name)
        self.assertEqual(len(self.calls),1)
    def test_duplicate_manifest_never_acknowledges(self):
        self.state['photos']*=2
        with self.assertRaises(mod.ClientError):self.client.fetch(self.session,self.temp.name)
        self.assertFalse(any(path.endswith('/ack') for _,path in self.calls))
    def test_delivery_token_binds_all_three_fields(self):
        token=self.client.delivery_token(self.session)
        self.client.thread='different'
        self.assertNotEqual(token,self.client.delivery_token(self.session))
        self.client.thread='chat-a';self.client.environment='host-b'
        self.assertNotEqual(token,self.client.delivery_token(self.session))
    def test_maintenance_paginates_and_prunes(self):
        pages=iter([{'purged_sessions':25,'more':True},{'purged_sessions':2,'more':False}])
        self.client.request=lambda *args,**kwargs:next(pages)
        result=mod.maintain(self.client,{},self.temp.name,7)
        self.assertEqual(result['purged_sessions'],27)
    def test_maintenance_alerts_once_and_preserves_failure(self):
        def fail(*args,**kwargs):raise mod.ClientError('Synthetic failure')
        self.client.request=fail
        with patch.object(mod.subprocess,'run') as notify:
            notify.return_value.returncode=0
            with self.assertRaisesRegex(mod.ClientError,'Synthetic failure'):
                mod.maintain(self.client,{'alert_command':['notify']},self.temp.name,7)
            notify.assert_called_once()
    def test_acknowledgement_recovery_uses_local_verified_bytes(self):
        self.client.fetch(self.session,self.temp.name)
        self.calls=[];self.state['state']='acknowledging'
        self.client.fetch(self.session,self.temp.name)
        self.assertFalse(any('/photos/' in path for _,path in self.calls))
    def test_no_redirect(self):
        with self.assertRaises(mod.ClientError):mod.NoRedirect().redirect_request(None,None,302,'',{},'https://elsewhere.example.test')
    def test_cache_symlink_refused(self):
        link=Path(self.temp.name)/'link';link.symlink_to(self.temp.name)
        with self.assertRaises(mod.ClientError):mod.private_directory(link)
    def test_cache_inside_repository_refused(self):
        (Path(self.temp.name)/'.git').mkdir()
        with self.assertRaises(mod.ClientError):mod.private_directory(Path(self.temp.name)/'photos')

if __name__=='__main__':unittest.main()
