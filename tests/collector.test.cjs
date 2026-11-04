const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { DOMParser, parseHTML } = require('linkedom');

const source = fs.readFileSync(path.join(__dirname, '..', 'chaoxing-learning-super-tool.user.js'), 'utf8');
// Synthetic identifiers only: no account, signature, or login data from the live page.
const baseUrl = 'https://mooc1.chaoxing.com/exam-ans/exam/test/reVersionTestStartNew?courseId=1&classId=2&tId=3&id=4&start=0&enc=test-signature';
const contents = ['为革兰氏阳性需氧杆菌', '在体外不良环境下易形成芽孢', '芽孢对外界有很强抵抗力', '繁殖体对日光、热和普通消毒剂均高度耐受'];
function page(order, { correct = 'D', role = 'radio', values = contents, answer = correct } = {}) {
    return `<html><body><div class="questionLi"><div class="stem">${order}. (单选题)\n关于炭疽杆菌，下列描述错误的是（ ）</div><div class="stem_answer">` + values.map((text, index) => {
        const label = 'ABCD'[index];
        return `<div class="clearfix answerBg singleoption" role="${role}"><span class="num_option${correct.includes(label) ? ' success' : ''}" data="${label}">${correct.includes(label) ? '' : label}</span><div class="answer_p">${text}</div></div>`;
    }).join('\n') + `</div><div class="eye_answer"><div class="same status1"><span class="myvacancy">正确答案:</span><span class="yoursanswer">${answer}</span></div></div><div>上一题 下一题</div><div>标记</div><script>globalThis.untrustedPageRan = true</script></div></body></html>`;
}
function harness({ total = 5, fetchImpl, autoReveal = true, href = baseUrl } = {}) {
    const memory = new Map();
    const context = vm.createContext({
        URL, DOMParser, AbortController, setTimeout, clearTimeout, console,
        location: { href, origin: new URL(href).origin },
        document: parseHTML(page(1)).document,
        localStorage: {
            getItem: key => memory.get(key) ?? null,
            setItem: (key, value) => memory.set(key, value),
            removeItem: key => memory.delete(key),
        },
        fetch: fetchImpl || (async (url, options) => {
            assert.equal(options.method, 'GET');
            assert.equal(options.credentials, 'same-origin');
            return { ok: true, url, text: async () => page(Number(new URL(url).searchParams.get('start')) + 1) };
        }),
    });
    const constants = source.slice(source.indexOf('    const APP = Object.freeze('), source.indexOf('    const DEFAULT_SETTINGS ='));
    const helpers = source.slice(source.indexOf('    const sleep ='), source.indexOf('    class SettingsStore'));
    const adapterAndStore = source.slice(source.indexOf('    class ChaoxingAdapter'), source.indexOf('    class Exporter'));
    const collector = source.slice(source.indexOf('    class Collector'), source.indexOf('    const adapter = new ChaoxingAdapter();'));
    vm.runInContext(constants + helpers + adapterAndStore + collector + '\nglobalThis.types = { ChaoxingAdapter, SessionStore, Collector };', context);
    const adapter = new context.types.ChaoxingAdapter();
    adapter.detectTotal = () => total;
    adapter.getScope = () => 'test-paper';
    adapter.getPaperTitle = () => '测试题库';
    const store = new context.types.SessionStore(adapter);
    const ui = { lastMessage: '', refresh() {}, setStatus(message) { this.lastMessage = message; } };
    const settings = { load: () => ({ autoRevealAnswer: autoReveal }) };
    return { context, adapter, store, ui, collector: new context.types.Collector(adapter, store, settings, ui) };
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('supports only the observed same-origin exam route and valid one-based orders', () => {
    const { adapter } = harness();
    assert.equal(adapter.supportsBatchCollection(), true);
    assert.equal(adapter.supportsBatchCollection(baseUrl.replace('mooc1.', 'mooc2.')), false);
    assert.equal(adapter.supportsBatchCollection(baseUrl.replace('/reVersionTestStartNew', '/submit')), false);
    const url = new URL(adapter.getBatchPageUrl(3));
    assert.equal(url.searchParams.get('start'), '2');
    assert.equal(url.searchParams.get('answeredView'), '1');
    assert.equal(url.searchParams.get('enc'), 'test-signature');
    assert.throws(() => adapter.getBatchPageUrl(0), /题号无效/);
});

test('entry links without start are supported and tag=1 is removed from numbered requests', async () => {
    const entry = new URL(baseUrl);
    entry.searchParams.delete('start');
    entry.searchParams.set('tag', '1');
    const requests = [];
    const h = harness({ href: entry.href, total: 3, fetchImpl: async url => {
        const request = new URL(url);
        assert.equal(request.searchParams.has('tag'), false);
        assert.equal(request.searchParams.get('enc'), 'test-signature');
        const order = Number(request.searchParams.get('start')) + 1;
        requests.push(order);
        return { ok: true, url, text: async () => page(order) };
    }});
    assert.equal(h.adapter.supportsBatchCollection(), true);
    const firstUrl = new URL(h.adapter.getBatchPageUrl(1));
    assert.equal(firstUrl.searchParams.get('start'), '0');
    assert.equal(firstUrl.searchParams.get('answeredView'), '1');
    assert.equal(firstUrl.searchParams.has('tag'), false);
    assert.equal(entry.searchParams.has('start'), false);
    assert.equal(entry.searchParams.get('tag'), '1');
    await h.collector.startBatch();
    assert.deepEqual(requests.slice().sort((a, b) => a - b), [1, 2, 3]);
    assert.equal(h.store.load().phase, 'completed');
});

test('optional start still rejects malformed offsets and missing paper identifiers', () => {
    const { adapter } = harness();
    for (const start of ['', '-1', 'abc', '1.5']) {
        const url = new URL(baseUrl);
        url.searchParams.set('start', start);
        assert.equal(adapter.supportsBatchCollection(url.href), false);
    }
    for (const key of ['courseId', 'classId', 'tId', 'id']) {
        const url = new URL(baseUrl);
        url.searchParams.delete(key);
        assert.equal(adapter.supportsBatchCollection(url.href), false);
    }
});

test('detached HTML parsing restores the correct option label without running scripts', () => {
    const { adapter, context } = harness();
    const item = adapter.parseBatchPage(page(2), 2, adapter.getBatchPageUrl(2));
    assert.equal(item.order, 2);
    assert.equal(item.answer, 'D');
    assert.deepEqual(Array.from(item.options), contents.map((text, index) => `${'ABCD'[index]}. ${text}`));
    assert.equal(context.untrustedPageRan, undefined);
    assert.throws(() => adapter.parseBatchPage(page(3), 2, baseUrl), /题号不匹配/);
    assert.throws(() => adapter.parseBatchPage('<html>请登录</html>', 2, baseUrl), /题号不匹配/);
    const missing = adapter.parseBatchPage(page(2, { answer: '' }), 2, baseUrl);
    assert.equal(missing.answer, '');
    assert.match(missing.missingAnswerReason, /未提供正确答案/);
});

test('hidden letters remain independent at every position, including multi-select and image-only options', () => {
    const { adapter } = harness();
    for (const correct of ['', 'A', 'B', 'C', 'D', 'AB', 'ACD', 'ABCD']) {
        for (const role of ['radio', 'checkbox']) {
            const question = parseHTML(page(2, { correct, role })).document.querySelector('.questionLi');
            assert.deepEqual(Array.from(adapter.extractOptions(question)), contents.map((text, index) => `${'ABCD'[index]}. ${text}`));
        }
    }
    const question = parseHTML(page(1, { correct: 'A', values: ['<img src="/image.png">', '文字选项'] })).document.querySelector('.questionLi');
    assert.deepEqual(Array.from(adapter.extractOptions(question)), ['A.', 'B. 文字选项']);
    const item = adapter.parseBatchPage(page(1, { values: ['<img src="/image.png">', '文字选项'] }), 1, baseUrl);
    assert.equal(item.images[0], 'https://mooc1.chaoxing.com/image.png');
});

test('legacy options and simplified/traditional control boundaries still work', () => {
    const { adapter } = harness();
    const question = html => parseHTML(`<div>${html}</div>`).document.firstElementChild;
    assert.deepEqual(Array.from(adapter.extractOptions(question('<ul class="options"><li>A. 一</li><li>B. 二</li></ul>'))), ['A. 一', 'B. 二']);
    for (const tail of ['显示答案', '顯示答案', '顯示正確答案', '上一题 下一题', '上一題 下一題', '标记', '標記']) {
        const html = ['A', '一', 'B', '二', tail, '不能混入选项'].map(text => `<div>${text}</div>`).join('');
        assert.deepEqual(Array.from(adapter.extractOptions(question(html))), ['A. 一', 'B. 二']);
    }
});

test('batch validates one request first, then uses at most two concurrent GETs and saves every item', async () => {
    const requests = [];
    let active = 0;
    let peak = 0;
    const { collector, store } = harness({ total: 8, fetchImpl: async (url, options) => {
        const order = Number(new URL(url).searchParams.get('start')) + 1;
        requests.push(order);
        active++;
        peak = Math.max(peak, active);
        assert.equal(options.method, 'GET');
        assert.equal(options.credentials, 'same-origin');
        await delay(order % 2 ? 8 : 3);
        active--;
        return { ok: true, url, text: async () => page(order) };
    }});
    await collector.startBatch();
    const session = store.load();
    assert.equal(peak, 2);
    assert.deepEqual(requests.slice(0, 1), [1]);
    assert.deepEqual(Array.from(session.items, item => item.order), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(session.phase, 'completed');
    assert.equal(session.active, false);
    assert.equal(collector.busy, false);
});

test('existing answers are preserved and only unfinished questions are fetched', async () => {
    const requests = [];
    const h = harness({ total: 3, fetchImpl: async url => {
        const order = Number(new URL(url).searchParams.get('start')) + 1;
        requests.push(order);
        return { ok: true, url, text: async () => page(order) };
    }});
    const session = h.store.create('paged');
    h.store.addItem(session, { order: 1, question: '已保存题目', answer: 'A', options: ['A. 保留'] });
    h.store.addSkipped(session, { order: 2, question: '原来没有答案' }, '未读取到答案');
    h.store.save(session);
    await h.collector.startBatch();
    assert.deepEqual(requests, [2, 3]);
    assert.equal(h.store.load().items[0].question, '已保存题目');
    assert.equal(h.store.load().skipped.length, 0);
});

test('missing answers at the first, middle, and last questions are saved without stopping batch collection', async () => {
    const requests = [];
    const h = harness({ total: 5, fetchImpl: async url => {
        const order = Number(new URL(url).searchParams.get('start')) + 1;
        requests.push(order);
        return { ok: true, url, text: async () => page(order, { answer: [1, 3, 5].includes(order) ? '' : 'D' }) };
    }});
    await h.collector.startBatch();
    const session = h.store.load();
    assert.equal(session.phase, 'completed');
    assert.equal(session.items.length, 5);
    assert.deepEqual(requests.slice().sort((a, b) => a - b), [1, 2, 3, 4, 5]);
    assert.deepEqual(Array.from(session.skipped, item => item.order).sort((a, b) => a - b), [1, 3, 5]);
    for (const item of session.items) {
        assert.equal(item.options.length, 4);
        assert.equal(item.answerStatus, [1, 3, 5].includes(item.order) ? 'missing' : 'answered');
    }
    assert.equal(h.store.stats(session).processedCount, 5);
    assert.equal(h.store.stats(session).answerCount, 2);
});

test('an all-unanswered paper completes with its questions and options intact', async () => {
    const h = harness({ total: 3, fetchImpl: async url => ({
        ok: true, url, text: async () => page(Number(new URL(url).searchParams.get('start')) + 1, { answer: '' }),
    }) });
    await h.collector.startBatch();
    const session = h.store.load();
    assert.equal(session.phase, 'completed');
    assert.equal(session.items.length, 3);
    assert.equal(session.skipped.length, 3);
    assert.equal(h.store.stats(session).answerCount, 0);
});

test('missing answer fields and explicit unavailable placeholders do not become fake answers', () => {
    const { adapter } = harness();
    for (const answer of ['暂无正确答案', '暫無答案', '答案未公布', '未提供答案']) {
        const item = adapter.parseBatchPage(page(2, { answer }), 2, baseUrl);
        assert.equal(item.answer, '');
        assert.equal(item.options.length, 4);
    }
    const withoutField = page(2).replace(/<div class="eye_answer">.*?<\/div><\/div>/, '');
    assert.equal(adapter.parseBatchPage(withoutField, 2, baseUrl).answer, '');
});

test('a failed probe does not fan out requests or mark a wrong page as processed', async () => {
    let requests = 0;
    const h = harness({ fetchImpl: async url => {
        requests++;
        return { ok: true, url, text: async () => page(99) };
    }});
    await h.collector.startBatch();
    assert.equal(requests, 1);
    assert.equal(h.store.load().items.length, 0);
    assert.equal(h.store.load().phase, 'error');
    assert.match(h.ui.lastMessage, /题号不匹配/);
});

test('HTTP errors and login redirects stop collection with a clear error', async () => {
    for (const response of [{ ok: false, status: 429 }, { ok: true, url: 'https://passport2.chaoxing.com/login' }]) {
        const h = harness({ fetchImpl: async () => response });
        await h.collector.startBatch();
        assert.equal(h.store.load().phase, 'error');
        assert.equal(h.store.load().items.length, 0);
        assert.match(h.ui.lastMessage, /429|重定向/);
    }
});

test('pause aborts active requests and a late response cannot overwrite paused progress', async () => {
    let h;
    h = harness({ fetchImpl: async (url, options) => {
        const order = Number(new URL(url).searchParams.get('start')) + 1;
        if (order === 2) h.collector.pause();
        await delay(5);
        return { ok: true, url, text: async () => page(order) };
    }});
    await h.collector.startBatch();
    assert.equal(h.store.load().phase, 'paused');
    assert.equal(h.store.load().active, false);
    assert.deepEqual(Array.from(h.store.load().items, item => item.order), [1]);
    assert.equal(h.collector.busy, false);
});

test('clear during a request does not recreate deleted data', async () => {
    const h = harness({ fetchImpl: async url => {
        h.collector.batchController.abort();
        h.store.clear();
        await delay(2);
        return { ok: true, url, text: async () => page(1) };
    }});
    await h.collector.startBatch();
    assert.equal(h.store.load(), null);
});

test('a worker error keeps completed items and can resume without fetching them again', async () => {
    let shouldFail = true;
    const requests = [];
    const h = harness({ total: 4, fetchImpl: async url => {
        const order = Number(new URL(url).searchParams.get('start')) + 1;
        requests.push(order);
        if (order === 2 && shouldFail) return { ok: false, status: 403 };
        return { ok: true, url, text: async () => page(order) };
    }});
    await h.collector.startBatch();
    assert.equal(h.store.load().phase, 'error');
    assert.equal(h.store.load().items[0].order, 1);
    shouldFail = false;
    await h.collector.startBatch();
    assert.equal(requests.filter(order => order === 1).length, 1);
    assert.equal(h.store.load().phase, 'completed');
    assert.equal(h.store.load().items.length, 4);
});

test('automatic reveal disabled and active tasks prevent batch requests', async () => {
    let requests = 0;
    const disabled = harness({ autoReveal: false, fetchImpl: async () => { requests++; } });
    await disabled.collector.startBatch();
    assert.equal(requests, 0);
    const h = harness({ fetchImpl: async () => { requests++; } });
    const session = h.store.create('paged');
    session.active = true;
    h.store.save(session);
    await h.collector.startBatch();
    assert.equal(requests, 0);
    assert.equal(h.store.load().mode, 'paged');
});

test('refresh pauses a saved batch task without starting background requests', () => {
    const h = harness();
    const session = h.store.create('batch');
    session.active = true;
    h.store.save(session);
    h.collector.autoResume();
    assert.equal(h.store.load().phase, 'paused');
    assert.match(h.ui.lastMessage, /后台批量采集/);
});

async function pagedScenario({ reveal = true, autoReveal = true, phase = 'collecting', attempts = 0 } = {}) {
    const h = harness({ total: 1, autoReveal });
    const session = h.store.create('paged');
    session.active = true;
    session.phase = phase;
    session.pendingAnswerOrder = phase === 'revealing' ? 1 : null;
    session.revealAttempts[1] = attempts;
    h.store.save(session);
    const waits = [];
    const actions = [];
    h.adapter.waitForQuestion = async () => ({});
    h.adapter.waitForStableCurrentOrder = async () => 1;
    h.adapter.getCurrentQuestionNode = () => ({});
    h.adapter.parseQuestion = () => ({ order: 1, question: '测试题目', answer: '', options: [] });
    h.adapter.findShowAnswer = () => reveal ? {} : null;
    h.adapter.waitForAnswer = async (node, order, timeout) => {
        waits.push(timeout);
        return phase === 'revealing' ? { item: { order: 1, question: '测试题目', answer: 'A' } } : null;
    };
    h.collector.navigate = (element, currentSession, action) => { actions.push(action); h.store.save(currentSession); return true; };
    await h.collector.resume();
    return { ...h, waits, actions };
}

test('visible reveal button skips the 650ms grace wait', async () => {
    const h = await pagedScenario();
    assert.deepEqual(h.waits, []);
    assert.deepEqual(h.actions, ['reveal-answer-1']);
    assert.equal(h.store.load().phase, 'revealing');
});

test('answer loading after a reveal keeps the full timeout', async () => {
    const h = await pagedScenario({ phase: 'revealing' });
    assert.deepEqual(h.waits, [2800]);
    assert.deepEqual(h.actions, []);
    assert.equal(h.store.load().items[0].answer, 'A');
});

test('missing buttons, disabled automatic reveal, and exhausted retries retain the grace wait', async () => {
    for (const settings of [{ reveal: false }, { autoReveal: false }, { attempts: 3 }]) {
        const h = await pagedScenario(settings);
        assert.deepEqual(h.waits, [650]);
        assert.deepEqual(h.actions, []);
    }
});
