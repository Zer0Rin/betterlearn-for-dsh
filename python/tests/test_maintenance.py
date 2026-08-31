from __future__ import annotations
import json
import sqlite3
from pathlib import Path
import pytest
from nobei_core.database import Phase1Database
from nobei_core.service import Phase1Core
from nobei_core.contract import load_candidate_contract
from nobei_core.errors import CoreProblem
from nobei_core import maintenance
from conftest import PYTHON_ROOT


def add_confirmed(database, text='😀证据完整。'):
    core=Phase1Core(database,load_candidate_contract(PYTHON_ROOT.parent))
    prepared=core.import_and_prepare_generation({'filename':'input.txt','mediaType':'text/plain','text':text,'modelSelection':{'provider':'fake','model':'fake'}})
    core.submit_generation({'runId':prepared['runId'],'attemptId':prepared['attemptId'],'expectedRevision':prepared['revision'], 'output':{'schemaVersion':1,'candidates':[{'type':'fact','title':'事实','statement':'已确认事实','evidence':[{'quote':text,'prefix':'','suffix':''}]}]}})
    candidate=core.list_candidates({'runId':prepared['runId']})['candidates'][0]
    core.review_candidate({'candidateId':candidate['candidateId'],'expectedRevision':1,'action':'accept','idempotencyKey':'idem_'+candidate['candidateId'].split('_')[1]})


def dump(path):
    with sqlite3.connect(path) as connection:
        names=[r[0] for r in connection.execute("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")]
        return {name:connection.execute(f'SELECT * FROM "{name}" ORDER BY rowid').fetchall() for name in names}


def test_live_wal_backup_restore_preserves_all_products_and_previous_database(owned_root,ownership_token,tmp_path):
    database=Phase1Database.open(owned_root,ownership_token)
    try:
        add_confirmed(database)
        assert (owned_root/'phase1.db-wal').exists()
        destination=tmp_path/'snapshot.sqlite'
        result=maintenance.backup(owned_root,destination)
        assert result=={'backupPath':str(destination)}
        saved=dump(destination)
        assert len(saved['knowledge_points'])==1
        assert len(saved['idempotency_records'])==1
        add_confirmed(database,'新增事实。')
        with pytest.raises(CoreProblem) as error:
            maintenance.restore(owned_root,ownership_token,destination,tmp_path/'backups')
        assert error.value.code=='CORE_INSTANCE_CONFLICT'
        assert database.scalar('SELECT count(*) FROM knowledge_points')==2
    finally:
        database.close()
    before=dump(owned_root/'phase1.db')
    result=maintenance.restore(owned_root,ownership_token,destination,tmp_path/'backups')
    assert result['restoredFrom']==str(destination)
    assert dump(Path(result['previousBackup']))==before
    assert dump(owned_root/'phase1.db')==saved
    reopened=Phase1Database.open(owned_root,ownership_token)
    try:
        assert reopened.scalar('SELECT count(*) FROM knowledge_points')==1
    finally: reopened.close()


@pytest.mark.parametrize('kind',['corrupt','unknown'])
def test_invalid_restore_never_changes_target(owned_root,ownership_token,tmp_path,kind):
    database=Phase1Database.open(owned_root,ownership_token)
    add_confirmed(database);database.close()
    before=dump(owned_root/'phase1.db')
    source=tmp_path/'invalid.sqlite'
    if kind=='corrupt': source.write_bytes(b'broken SQLite')
    elif kind=='unknown':
        with sqlite3.connect(source) as connection: connection.execute('CREATE TABLE unknown(x)')
    with pytest.raises((CoreProblem,maintenance.MaintenanceError,sqlite3.Error)):
        maintenance.restore(owned_root,ownership_token,source,tmp_path/'backups')
    assert dump(owned_root/'phase1.db')==before
    assert not (tmp_path/'backups').exists()


def test_backup_refuses_overwrite_and_data_directory(owned_root,ownership_token,tmp_path):
    database=Phase1Database.open(owned_root,ownership_token)
    try:
        destination=tmp_path/'existing.sqlite';destination.write_bytes(b'keep')
        with pytest.raises(FileExistsError): maintenance.backup(owned_root,destination)
        assert destination.read_bytes()==b'keep'
        with pytest.raises(maintenance.MaintenanceError): maintenance.backup(owned_root,owned_root/'extra.sqlite')
        assert not (owned_root/'extra.sqlite').exists()
    finally: database.close()


def test_failed_preservation_prevents_restore(owned_root,ownership_token,tmp_path,monkeypatch):
    database=Phase1Database.open(owned_root,ownership_token)
    source=tmp_path/'snapshot.sqlite';maintenance.backup(owned_root,source)
    add_confirmed(database);database.close()
    before=dump(owned_root/'phase1.db')
    def fail(*args): raise OSError('disk full')
    monkeypatch.setattr(maintenance,'_save',fail)
    with pytest.raises(OSError): maintenance.restore(owned_root,ownership_token,source,tmp_path/'backups')
    assert dump(owned_root/'phase1.db')==before


def test_cli_machine_json_and_failure_does_not_print_token(owned_root,ownership_token,tmp_path,capsys):
    database=Phase1Database.open(owned_root,ownership_token)
    try:
        destination=tmp_path/'snapshot.sqlite'
        assert maintenance.main(['backup','--data-root',str(owned_root),'--to',str(destination)])==0
        assert json.loads(capsys.readouterr().out)=={'backupPath':str(destination)}
        assert maintenance.main(['restore','--data-root',str(owned_root),'--ownership-token',ownership_token,'--from',str(destination),'--backup-dir',str(tmp_path/'backups')])==1
        captured=capsys.readouterr()
        assert captured.out==''
        assert 'CORE_INSTANCE_CONFLICT' in captured.err
        assert ownership_token not in captured.err
    finally: database.close()
