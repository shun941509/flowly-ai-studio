"""Pure local calculations for strengthened examples; no providers or network."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('technical', Path(__file__).parents[1] / 'export-runtime' / 'completion_programs.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


class ExampleStrengthening(unittest.TestCase):
    def test_lease_renewal_reclaim_and_old_token_cannot_publish(self):
        board={'revision':0,'tasks':{'analysis':{'status':'pending'},'implementation':{'status':'pending','dependsOn':['analysis']}}}
        base={'board':board,'expectedRevision':0,'taskId':'analysis','actor':'a','now':100,'leaseSeconds':10,'action':'claim'}
        first=p.board_transition(base)
        renewed=p.board_transition(dict(base,board=first['board'],expectedRevision=1,claimRevision=1,action='renew',now=105))
        self.assertEqual(renewed['board']['tasks']['analysis']['leaseUntil'],115)
        reclaim=dict(base,board=renewed['board'],expectedRevision=2,action='reclaim',now=115,actor='b')
        second=p.board_transition(reclaim)
        self.assertTrue(second['passed']);self.assertEqual(second['board']['tasks']['analysis']['attempt'],2)
        publish=dict(base,board=second['board'],expectedRevision=3,action='publish',now=116,actor='b',artifact={'text':'done'})
        self.assertFalse(p.board_transition(dict(publish,claimRevision=1))['passed'])
        done=p.board_transition(dict(publish,claimRevision=3))
        self.assertEqual(done['readyTaskIds'],['implementation'])
        request=p.board_request({'board':done['board'],'request':{'actor':'b'},'step':'claim_implementation'})
        self.assertTrue(p.board_transition(dict(request,now=116))['passed'])

    def test_case_events_share_business_case_and_do_not_replay_reminders(self):
        empty={'revision':0,'cases':{},'events':{}}
        opened={'caseId':'c','eventId':'o','kind':'open','at':1,'deadline':10}
        state=p.case_event({'ledger':empty,'event':opened})
        self.assertEqual(state['action'],'waiting')
        self.assertFalse(p.case_event({'ledger':state['ledger'],'event':opened})['changed'])
        with self.assertRaises(ValueError):p.case_event({'ledger':state['ledger'],'event':dict(opened,deadline=11)})
        before=p.case_event({'ledger':state['ledger'],'event':{'caseId':'c','eventId':'early','kind':'deadline','at':9}})
        self.assertEqual(before['action'],'not_due')
        due=p.case_event({'ledger':before['ledger'],'event':{'caseId':'c','eventId':'due','kind':'deadline','at':10}})
        self.assertEqual(due['action'],'remind')
        repeated=p.case_event({'ledger':due['ledger'],'event':{'caseId':'c','eventId':'different','kind':'deadline','at':11}})
        self.assertEqual(repeated['action'],'reminder_reserved')
        late=p.case_event({'ledger':repeated['ledger'],'event':{'caseId':'c','eventId':'late','kind':'response','at':12,'response':'late'}})
        self.assertEqual(late['action'],'late_response');self.assertNotEqual(late['case']['status'],'closed')
        actual=p.case_delivery({'transition':due,'receipt':{'caseId':'c','eventId':'due','receiptId':'r','sent':True}})
        self.assertEqual(actual['case']['status'],'reminded')
        with self.assertRaises(ValueError):p.case_delivery({'transition':due,'receipt':{'caseId':'other','eventId':'due','receiptId':'r','sent':True}})
        closed=p.case_event({'ledger':state['ledger'],'event':{'caseId':'c','eventId':'response','kind':'response','at':9,'response':'done'}})
        self.assertEqual(closed['action'],'closed')

    def test_regression_set_requires_improvement_and_no_old_answer_loss(self):
        cases=lambda flags:[{'query':q,'resourceId':'doc','passed':flag} for q,flag in zip(('release','backup','rollback'),flags)]
        args={'beforeChecks':cases((False,True,True)),'afterChecks':cases((True,True,True)),'baselineGeneration':'g1','candidateGeneration':'g2'}
        self.assertTrue(p.improvement(args)['passed'])
        failed=p.improvement(dict(args,afterChecks=cases((True,False,True))))
        self.assertFalse(failed['passed']);self.assertEqual(failed['regressedQueries'],['backup'])
        self.assertFalse(p.improvement(dict(args,beforeChecks=cases((True,True,True))))['passed'])
        with self.assertRaises(ValueError):p.improvement(dict(args,afterChecks=cases((True,True))))


if __name__ == '__main__':
    unittest.main()
