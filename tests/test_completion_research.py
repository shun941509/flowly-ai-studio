import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('completion_research', Path(__file__).parents[1] / 'export-runtime' / 'completion_research.py')
research = importlib.util.module_from_spec(spec)
spec.loader.exec_module(research)


class ResearchContracts(unittest.TestCase):
    def run_contract(self, name, **changes):
        data = copy.deepcopy(research.CONTRACTS['research.' + name]['exampleArguments'])
        data.update(changes)
        return research.OPERATIONS['research.' + name](data)

    def test_all_declared_examples_execute_without_io(self):
        self.assertEqual(set(research.OPERATIONS), set(research.CONTRACTS))
        for name, contract in research.CONTRACTS.items():
            with self.subTest(name=name):
                args = copy.deepcopy(contract['exampleArguments']); before = copy.deepcopy(args)
                result = research.OPERATIONS[name](args)
                self.assertIsInstance(result, dict)
                self.assertEqual(args, before, 'Pure contract mutated its input')
                self.assertGreater(len(contract['description']), 20)

    def test_relation_requires_actual_unvisited_reference(self):
        self.assertEqual(self.run_contract('frontier')['nextQuery'], 'B 조회')
        with self.assertRaises(ValueError): self.run_contract('frontier', visited=['b'])
        with self.assertRaises(ValueError): self.run_contract('frontier', proposal={'sourceId':'a','targetId':'b','query':'없는 질문'})

    def test_policy_period_precedes_authority_and_conflict_requires_current_choice(self):
        current = self.run_contract('policy_resolve')['chosen']
        expired = {**current, 'id':'expired','authority':100,'effectiveUntil':'2026-01-01T00:00:00Z'}
        self.assertEqual(self.run_contract('policy_resolve',documents=[expired,current])['chosen']['id'],'p1')
        other = {**current,'id':'p2','value':'4일'}
        self.assertEqual(self.run_contract('policy_resolve',documents=[current,other])['state'],'needs_review')
        with self.assertRaises(ValueError): self.run_contract('policy_resolve',documents=[current,other],selectedId='expired')

    def test_actual_diff_and_unconfirmed_impact(self):
        change = self.run_contract('policy_diff')
        self.assertEqual(change['changes'][0]['kind'],'modified')
        self.assertNotEqual(change['oldHash'],change['newHash'])
        result = self.run_contract('impact_search',registry=[{'taskId':'u','policyRefs':[],'referencesComplete':False}])
        self.assertEqual(result['unconfirmedTaskIds'],['u'])

    def test_intake_deduplicates_hash_and_isolates_permission(self):
        accepted = self.run_contract('intake')
        duplicate = self.run_contract('intake',existing=accepted['manifest'])
        self.assertEqual(duplicate['duplicates'],['guide'])
        self.assertFalse(duplicate['ready'])
        self.assertEqual(self.run_contract('intake',permissions={})['rejected'][0]['reason'],'permission_denied')

    def test_intake_preserves_nonlast_document_and_rechecks_retained_permissions(self):
        first = self.run_contract('intake')
        second = self.run_contract('intake', existing=first['manifest'], documents=[{'resourceId':'appendix','version':'v1','content':'release appendix'}], allowedIds=['guide','appendix'], permissions={'guide':True,'appendix':True})
        self.assertEqual({d['resourceId'] for d in second['manifest']},{'guide','appendix'})
        self.assertEqual({d['resourceId'] for d in second['documents']},{'guide','appendix'})
        self.assertFalse(self.run_contract('intake',existing=second['manifest'])['ready'])
        changed=self.run_contract('intake',existing=second['manifest'],documents=[{'resourceId':'appendix','version':'v2','content':'release new'}],allowedIds=['guide','appendix'],permissions={'guide':False,'appendix':True})
        self.assertEqual([d['resourceId'] for d in changed['documents']],['appendix'])
        self.assertEqual(len(changed['manifest']),2)

    def test_batch_pages_and_repair_exact_failed_set(self):
        pages = self.run_contract('batch_prepare',items=[{'id':str(i),'value':i} for i in range(400)],pageSize=20)
        self.assertEqual(len(pages['pages']),20)
        self.assertEqual(pages['pages'][-1]['nextCursor'],20)
        repaired = self.run_contract('batch_repairs')
        self.assertEqual(repaired['reusedCount'],1)
        self.assertEqual(repaired['retriedIds'],['b'])
        with self.assertRaises(ValueError): self.run_contract('batch_repairs',repairs=[{'id':'a','value':2},{'id':'b','value':3}])
        with self.assertRaises(ValueError): self.run_contract('batch_prepare',items=[{'id':str(i),'value':i} for i in range(401)])

    def test_more_than_twenty_repairs_reuse_the_same_page_contract(self):
        for count in (21,400):
            failed=[{'id':str(i),'status':'failed'} for i in range(count)]
            prepared=research.batch_repair_prepare({'completed':[],'failed':failed,'repairs':[{'id':str(i),'value':i} for i in range(count)]})
            pages=[{'output':research.batch_page(page)} for page in prepared['pages']]
            actual=research.batch_collect({'pages':pages})
            merged=research.batch_repair_merge({'completed':[],'failed':failed,'retried':actual['rows']})
            self.assertTrue(merged['passed']);self.assertEqual(len(merged['completed']),count)
            self.assertEqual(merged['completed'][-1]['squared'],(count-1)**2)
        with self.assertRaises(ValueError):research.batch_repair_prepare({'completed':[],'failed':[{'id':'a'}],'repairs':[{'id':'a','value':2},{'id':'a','value':3}]})

    def test_request_ledger_reserves_before_writes_and_preserves_other_requests(self):
        empty={'revision':0,'requests':{}}
        r1={'requestId':'R1','title':'one','mode':'create'}
        first=research.transfer_begin({'ledger':empty,'request':r1})
        self.assertEqual(first['expectedRevision'],0);self.assertEqual(first['ledger']['revision'],1)
        self.assertEqual(research.transfer_begin({'ledger':first['ledger'],'request':r1})['mode'],'reconcile')
        crm=research.transfer_record({'ledger':first['ledger'],'requestId':'R1','stage':'crm','receipt':{'requestId':'R1','crmId':'C1'}})
        second=research.transfer_begin({'ledger':crm['ledger'],'request':{'requestId':'R2','title':'two','mode':'create'}})
        again=research.transfer_begin({'ledger':second['ledger'],'request':r1})
        self.assertEqual(again['request']['crmId'],'C1');self.assertEqual(len(again['ledger']['requests']),2)
        with self.assertRaises(ValueError):research.transfer_begin({'ledger':second['ledger'],'request':dict(r1,title='changed')})
        with self.assertRaises(ValueError):research.transfer_record({'ledger':crm['ledger'],'requestId':'R1','stage':'ticket','receipt':{'requestId':'R1','crmId':'C2','ticketId':'T1','created':True}})

    def test_old_single_receipt_blocks_new_requests_without_deleting_history(self):
        legacy={'requestId':'legacy-R1','crmId':'C-legacy','ticketId':'T-legacy'}
        before=copy.deepcopy(legacy)
        for mode in ('create','reconcile'):
            with self.assertRaisesRegex(ValueError,'구형 transfer_stage'):
                research.transfer_begin({'ledger':{'revision':0,'requests':{}},'legacy':legacy,'request':{'requestId':'R1','title':'new','mode':mode}})
        self.assertEqual(legacy,before)

    def test_same_score_contract_rejects_capacity_and_reports_tie(self):
        args = copy.deepcopy(research.CONTRACTS['research.candidate_score']['exampleArguments'])
        args['candidates']=[{'id':'a','selected':['a','b']},{'id':'b','selected':['b']}]
        result=research.candidate_score(args)
        self.assertFalse(result['scores'][0]['passed']);self.assertEqual(result['selection']['winner'],'b')
        self.assertEqual(self.run_contract('choose_candidate',scores=[{'candidateId':'a','passed':True,'score':1},{'candidateId':'b','passed':True,'score':1}])['state'],'tie')

    def test_budget_consumption_changes_selected_scope(self):
        budget = copy.deepcopy(research.CONTRACTS['research.budget_plan']['exampleArguments']['runtimeBudget'])
        essential = {'id':'essential','required':True,'cost':{'turns':1,'tools':0,'tokens':10,'durationMs':1}}
        optional = {**essential,'id':'optional','required':False}
        self.assertFalse(self.run_contract('budget_plan',tasks=[essential],runtimeBudget=budget)['optionalSelected'])
        self.assertTrue(self.run_contract('budget_plan',tasks=[essential,optional],runtimeBudget=budget)['optionalSelected'])
        budget['usedTurns']=8
        blocked = self.run_contract('budget_plan',runtimeBudget=budget)
        self.assertEqual(blocked['state'],'blocked')
        self.assertFalse(blocked['optionalSelected'])
        with self.assertRaises(KeyError): research.budget_plan({'tasks':[]})

    def test_response_does_not_trust_wrong_target_staleness_or_conflicting_values(self):
        base = copy.deepcopy(research.CONTRACTS['research.response_trust']['exampleArguments']['responses'][0])
        self.assertEqual(self.run_contract('response_trust',responses=[{**base,'target':'other'}])['state'],'retry')
        self.assertEqual(self.run_contract('response_trust',responses=[{**base,'observedAt':'2020-01-01T00:00:00Z'}])['state'],'retry')
        self.assertEqual(self.run_contract('response_trust',responses=[base,{**base,'value':'blocked','source':'second'}])['state'],'review')

    def test_raw_table_normalizes_units_but_preserves_citations(self):
        result = self.run_contract('table_reconcile')
        self.assertTrue(result['passed']);self.assertEqual(result['rows'][0]['table']['total'],2000)
        self.assertEqual(result['rows'][0]['sourceLine'],1);self.assertIn('D2',result['rows'][0]['cells'])
        self.assertFalse(self.run_contract('table_reconcile',documentText='A|2000|g|2|KRW')['passed'])
        with self.assertRaises(ValueError): self.run_contract('table_reconcile',documentText='A|2|unknown|1000|KRW')

    def test_readonly_data_contract_rejects_numeric_strings_and_extra_columns(self):
        with self.assertRaises(ValueError): self.run_contract('data_contract',rows=[{'day':'월','count':'10'}])
        with self.assertRaises(ValueError): self.run_contract('data_contract',rows=[{'day':'월','count':10,'secret':'x'}])

    def test_ledger_detects_nonlast_duplicate_and_reconciles_pending(self):
        pending=self.run_contract('notification')
        self.assertEqual(self.run_contract('notification',ledger=pending['ledger'])['state'],'reconcile')
        sent=self.run_contract('notification_commit',ledger=pending['ledger'])
        e2={**research._event,'eventId':'e2','at':'2026-10-25T00:01:00Z','state':'ready'}
        later=self.run_contract('notification',event=e2,ledger=sent['ledger'])
        self.assertEqual(self.run_contract('notification',ledger=later['ledger'])['state'],'duplicate')
        with self.assertRaises(ValueError): self.run_contract('notification_commit',receipt={'eventId':'wrong','receiptId':'r1'})

    def test_project_memory_scope_provenance_expiry_and_conflict_history(self):
        first=self.run_contract('project_memory_commit')
        self.assertEqual(first['active'][0]['accepted'],True)
        changed={**research._lesson,'value':'조회 결과를 저장한다.'}
        result=self.run_contract('project_memory_commit',store=first['store'],candidate=changed)
        self.assertEqual(len(result['conflicts']),1);self.assertEqual(len(result['active']),1)
        with self.assertRaises(ValueError): self.run_contract('project_memory',candidate={**research._lesson,'projectId':'P2'})
        with self.assertRaises(ValueError): self.run_contract('project_memory',candidate={**research._lesson,'expiresAt':'2020-01-01T00:00:00Z'})
        with self.assertRaises(ValueError): self.run_contract('project_memory',candidate={**research._lesson,'sources':[{'id':'test1','quote':'없는 근거'}]})

    def test_replan_only_invalidates_transitive_dependencies(self):
        result=self.run_contract('repair_plan')
        self.assertEqual(result['invalidated'],['analysis']);self.assertEqual(result['preserved'],{'facts':{'value':2}})
        tasks=research._tasks+[{'id':'report','handler':'publish','dependsOn':['analysis']}]
        self.assertEqual(self.run_contract('repair_plan',tasks=tasks)['invalidated'],['analysis','report'])
        with self.assertRaises(ValueError): self.run_contract('repair_plan',replacements=[{'taskId':'analysis','assignee':'unknown'}])

    def test_hypothesis_real_observation_updates_and_blocks_useless_choice(self):
        result=self.run_contract('hypothesis_update')
        self.assertEqual(result['winner'],'compute');self.assertEqual(result['states'][0]['state'],'refuted')
        with self.assertRaises(ValueError): self.run_contract('hypothesis_update',selectedFeature='color')

    def test_counterexample_then_regression_preserves_old_success(self):
        self.assertEqual(self.run_contract('regression')['counterexamples'],[{'x':0}])
        self.assertTrue(self.run_contract('regression',candidate=research._rule)['passed'])
        self.assertFalse(self.run_contract('regression',candidate={'op':'eq','field':'x','value':0})['passed'])
        with self.assertRaises(ValueError): self.run_contract('regression',candidate={'op':'eval','field':'x','value':0})

    def test_edit_version_and_cross_service_receipt_must_match(self):
        version=self.run_contract('version')
        self.assertTrue(self.run_contract('version',decision={'versionHash':version['versionHash']})['valid'])
        with self.assertRaises(ValueError): self.run_contract('version',decision={'versionHash':'old'})
        with self.assertRaises(ValueError): self.run_contract('receipt',receipt={'requestId':'r1','crmId':'wrong','ticketId':'t1'})


if __name__ == '__main__': unittest.main()
