from __future__ import annotations
import base64
import io
from pathlib import Path
import pytest
from pypdf import PdfWriter
from nobei_core.contract import load_candidate_contract
from nobei_core.extraction import extraction_plan
from nobei_core.service import Phase1Core
from nobei_core.errors import CoreProblem
from conftest import PYTHON_ROOT

@pytest.fixture
def core(database):
    return Phase1Core(database, load_candidate_contract(PYTHON_ROOT.parent))

def prepare(core, text):
    return core.import_and_prepare_generation({'filename':'long.txt','mediaType':'text/plain','text':text,'modelSelection':{'provider':'fake','model':'fake'}})

def output(quote, title='same'):
    return {'schemaVersion':1,'candidates':[{'type':'fact','title':title,'statement':'statement', 'evidence':[{'quote':quote,'prefix':'','suffix':''}]}]}

def submit(core, prepared, batches):
    return core.submit_generation({'runId':prepared['runId'],'attemptId':prepared['attemptId'], 'expectedRevision':prepared['revision'],'output':{'batches':batches}})

@pytest.mark.parametrize('length,strategy', [(6000,'L1'),(6001,'L2'),(24000,'L2'),(24001,'L3'),(90000,'L3')])
def test_plans_cover_all_unicode_source(core,database,length,strategy):
    text=('😀段落\n\n'* (length//5+1))[:length]
    result=core.preview_document({'filename':'long.txt','mediaType':'text/plain','text':text})
    plan=result['extractionPlan']; assert plan['strategy']==strategy
    assert ''.join(text[b['textStart']:b['textEnd']] for b in plan['blocks'])==text
    assert all(b['textEnd']-b['textStart']<=4000 for b in plan['blocks'])
    covered=set()
    for container in plan['containers']:
        assert len(container['blockIds'])<=6 if strategy=='L3' else True
        covered.update(container['blockIds'])
    assert covered=={b['id'] for b in plan['blocks']}
    assert plan['containers'][-1]['textEnd']==len(text)
    assert database.scalar('SELECT count(*) FROM runs')==0
    if strategy!='L1': assert prepare(core,text)['extractionPlan']==plan


def test_pdf_preview_chinese_pages_and_readonly(core,database):
    data=(Path(__file__).parent/'fixtures/chinese-two-pages.pdf').read_bytes()
    result=core.preview_document({'filename':'中文.pdf','mediaType':'application/pdf','contentBase64':base64.b64encode(data).decode()})
    assert result['text']=='第一页：能量守恒。\n\n第二页：质量与速度。'
    assert [result['text'][p['textStart']:p['textEnd']] for p in result['pages']]==['第一页：能量守恒。','第二页：质量与速度。']
    assert database.scalar('SELECT count(*) FROM documents')==0
    imported=core.import_text({k:result[k] for k in ('filename','mediaType','text')})
    assert core.get_run({'runId':imported['runId']})['document']['mediaType']=='application/pdf'

@pytest.mark.parametrize('kind,code',[('malformed','PDF_MALFORMED'),('encrypted','PDF_ENCRYPTED'),('scanned','PDF_NO_TEXT')])
def test_bad_pdf_explicit_errors(core,kind,code):
    writer=PdfWriter();writer.add_blank_page(width=100,height=100)
    if kind=='encrypted': writer.encrypt('secret')
    data=io.BytesIO();writer.write(data)
    raw=b'not pdf' if kind=='malformed' else data.getvalue()
    with pytest.raises(CoreProblem) as error:
        core.preview_document({'filename':'bad.pdf','mediaType':'application/pdf','contentBase64':base64.b64encode(raw).decode()})
    assert error.value.code==code


def test_batches_merge_repeated_quote_at_absolute_nonfirst_offsets(core,database):
    text='😀'*25000+'甲事实。'+'间'*4000+'甲事实。尾'
    prepared=prepare(core,text)
    ranges=[(25000,25004),(29004,len(text))]
    batches=[{'textStart':a,'textEnd':b,'output':output('甲事实。')} for a,b in ranges]
    result=submit(core,prepared,batches+[batches[0]])
    assert result['run']['counts']['validCandidates']==1
    candidate=core.list_candidates({'runId':prepared['runId']})['candidates'][0]
    assert [e['textStart'] for e in candidate['evidence']]==[25000,29004]
    assert all(text[e['textStart']:e['textEnd']]==e['quote'] for e in candidate['evidence'])
    reviewed=core.review_candidate({'candidateId':candidate['candidateId'],'action':'accept','expectedRevision':1,'idempotencyKey':'idem_'+'b'*20})
    assert len(reviewed['knowledgePoint']['evidence'])==2


def test_invalid_later_batch_never_commits_partial_candidates(core,database):
    prepared=prepare(core,'x'*30000+'tail')
    result=submit(core,prepared,[{'textStart':30000,'textEnd':30004,'output':output('tail')},{'textStart':0,'textEnd':30001,'output':{'candidates':[]}}])
    assert result['run']['status']=='failed_retryable'
    assert database.scalar('SELECT count(*) FROM candidates')==0


def test_merge_more_than64_evidence_fails_atomically(core,database):
    text=''.join(f'line{i:03d}\n' for i in range(65))+'x'*300000
    prepared=prepare(core,text)
    batches=[{'textStart':i*8,'textEnd':(i+1)*8,'output':output(f'line{i:03d}')} for i in range(65)]
    result=submit(core,prepared,batches)
    assert result['run']['status']=='failed_retryable'
    assert database.scalar('SELECT count(*) FROM candidates')==0

@pytest.mark.parametrize('count,failed',[(1000,False),(1001,True)])
def test_aggregate_candidate_limit_is_explicit(core,database,count,failed):
    text='source'+'x'*300000
    prepared=prepare(core,text)
    candidates=[output('source',f'candidate{i}')['candidates'][0] for i in range(count)]
    batches=[{'textStart':0,'textEnd':6,'output':{'schemaVersion':1,'candidates':candidates[i:i+20]}} for i in range(0,count,20)]
    result=submit(core,prepared,batches)
    assert result['run']['status']==('failed_retryable' if failed else 'review_pending')
    assert database.scalar('SELECT count(*) FROM candidates')==(0 if failed else count)


def test_64_distinct_evidence_accept_and_idempotent_review(core,database):
    text=''.join(f'line{i:03d}\n' for i in range(64))+'\t'*(524288-64*8)
    prepared=prepare(core,text)
    batches=[{'textStart':i*8,'textEnd':(i+1)*8,'output':output(f'line{i:03d}')} for i in range(64)]
    result=submit(core,prepared,batches)
    assert result['run']['status']=='review_pending'
    candidate=core.list_candidates({'runId':prepared['runId']})['candidates'][0]
    command={'candidateId':candidate['candidateId'],'action':'accept','expectedRevision':1,'idempotencyKey':'idem_'+'c'*20}
    result=core.review_candidate(command)
    assert len(result['knowledgePoint']['evidence'])==64
    assert core.review_candidate(command)==result
    assert database.scalar('SELECT count(*) FROM knowledge_point_evidence')==64
