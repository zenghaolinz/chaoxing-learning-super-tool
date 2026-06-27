// ==UserScript==
// @name         学习通超级工具
// @namespace    https://github.com/zenghaolinz/chaoxing-answer-exporter
// @version      1.5.1
// @description  学习通超级工具：题目采集/导出/AI答题/回填 + 视频自动播放、保活、自动下一节、章节测验 AI 作答，统一浮窗开关
// @author       zenghaolinz
// @license      MIT
// @homepageURL  https://github.com/zenghaolinz/chaoxing-answer-exporter
// @supportURL   https://github.com/zenghaolinz/chaoxing-answer-exporter/issues
// @match        *://*.chaoxing.com/*
// @match        *://mobilelearn.chaoxing.com/*
// @require      https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        unsafeWindow
// @connect      api.deepseek.com
// @connect      *
// ==/UserScript==

(() => {
    'use strict';

    // mooc2-ans 页面经常只是一个 iframe 外壳，真正的题目在 mobilelearn.chaoxing.com 的 frame 内。
    // 在外壳页挂载面板会导致只能扫到 iframe/底部确认框，无法采集题目；因此外壳页直接退出，交给 iframe 内匹配到的脚本实例运行。
    function isOuterChaoxingFrameShell() {
        if (window.top !== window) return false;
        if (!/mooc2-ans\.chaoxing\.com$/i.test(location.hostname)) return false;
        const hasQuestionInCurrentDocument = Boolean(document.querySelector(
            '.question-item, .questionLi, .mark_item, .question-name, .question-title, [data-question-id], [data-questionid]'
        ));
        if (hasQuestionInCurrentDocument) return false;
        return Boolean(document.querySelector(
            '#frame_content-hd, iframe[src*="mobilelearn.chaoxing.com"], iframe[src*="/page/quiz/"], iframe[src*="/page/active/"]'
        ));
    }

    if (isOuterChaoxingFrameShell()) return;

    const APP = Object.freeze({
        id: 'cx-answer-exporter',
        name: '学习通超级工具',
        version: '1.5.1',
        storageVersion: 1,
        sessionPrefix: 'CXAE_SESSION_',
        settingsKey: 'CXAE_SETTINGS',
        aiTaskPrefix: 'CXAE_AI_TASK_',
        maxRevealAttempts: 3,
        maxJumpAttempts: 2,
        navigationDelay: 120,
        domSettleDelay: 90,
        answerGraceTimeout: 650,
        answerRevealTimeout: 2800,
        questionNodeCacheTtl: 180,
        navigationCacheTtl: 220,
        questionWaitTimeout: 15000,
        aiNavigationTimeout: 12000,
    });

    const DEFAULT_SETTINGS = Object.freeze({
        autoRevealAnswer: true,
        includeTimestamp: true,
        aiApiBase: 'https://api.deepseek.com',
        aiApiKey: '',
        aiModel: 'deepseek-v4-flash',
        aiThinkingEnabled: false,
        autoFillDelay: 500,
        collectionDelay: 120,
    });

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    function clampNumber(value, minimum, maximum, fallback) {
        const number = Number(value);
        if (!Number.isFinite(number)) return fallback;
        return Math.max(minimum, Math.min(maximum, number));
    }

    function normalizeText(value) {
        return String(value ?? '')
            .replace(/\u00a0/g, ' ')
            .replace(/[ \t]+/g, ' ')
            .replace(/\r/g, '')
            .trim();
    }

    function safeFileName(value) {
        return normalizeText(value || '超星题目')
            .replace(/[\\/:*?"<>|]/g, '_')
            .replace(/\s+/g, ' ')
            .slice(0, 80) || '超星题目';
    }

    function timestampText(date = new Date()) {
        const pad = value => String(value).padStart(2, '0');
        return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
    }

    function simpleHash(text) {
        let hash = 2166136261;
        for (let index = 0; index < text.length; index += 1) {
            hash ^= text.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0).toString(36);
    }

    function isVisible(element) {
        if (!element || !element.isConnected) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
    }

    function isDisabled(element) {
        if (!element) return true;
        const className = String(element.className || '');
        return Boolean(
            element.disabled ||
            element.getAttribute('aria-disabled') === 'true' ||
            /disabled|disable|forbid|ban|gray|grey/i.test(className)
        );
    }

    function downloadBlob(content, filename, mimeType) {
        const blob = content instanceof Blob ? content : new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        anchor.style.display = 'none';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1500);
    }

    class SettingsStore {
        load() {
            try {
                const parsed = JSON.parse(localStorage.getItem(APP.settingsKey) || '{}');
                const settings = { ...DEFAULT_SETTINGS, ...parsed };
                // 兼容旧版 DeepSeek 配置。仅迁移官方 API，不影响第三方 OpenAI 兼容服务。
                if (/^https:\/\/api\.deepseek\.com\/v1\/?$/i.test(normalizeText(settings.aiApiBase))) {
                    settings.aiApiBase = 'https://api.deepseek.com';
                }
                if (/api\.deepseek\.com/i.test(normalizeText(settings.aiApiBase))) {
                    if (settings.aiModel === 'deepseek-chat') settings.aiModel = 'deepseek-v4-flash';
                    if (settings.aiModel === 'deepseek-reasoner') settings.aiModel = 'deepseek-v4-pro';
                }
                // 从 GM 安全存储读取 API Key（如果可用）
                if (typeof GM_getValue === 'function') {
                    const secureKey = GM_getValue('CXAE_AI_API_KEY', '');
                    if (secureKey) settings.aiApiKey = secureKey;
                }
                return settings;
            } catch (error) {
                console.warn('[CXAE] 读取设置失败，使用默认值。', error);
                return { ...DEFAULT_SETTINGS };
            }
        }

        save(settings) {
            // API Key 优先存入用户脚本管理器，避免明文写入页面 localStorage。
            const safeCopy = { ...settings };
            delete safeCopy.aiApiKey;

            if (typeof GM_setValue === 'function') {
                if (settings.aiApiKey) {
                    GM_setValue('CXAE_AI_API_KEY', settings.aiApiKey);
                } else if (typeof GM_deleteValue === 'function') {
                    GM_deleteValue('CXAE_AI_API_KEY');
                } else {
                    GM_setValue('CXAE_AI_API_KEY', '');
                }
                localStorage.setItem(APP.settingsKey, JSON.stringify(safeCopy));
                return;
            }

            localStorage.setItem(APP.settingsKey, JSON.stringify(settings));
        }
    }

    let _vuePracticeCache = null;
    let _vuePracticeCacheTime = 0;
    const VUE_CACHE_TTL = 2000; // Vue 上下文缓存 2 秒

    class ChaoxingAdapter {
        constructor() {
            this._domRevision = 0;
            this._domObserver = null;
            this._questionNodeCache = null;
            this._navigationCandidateCache = null;
        }

        ensureDomObserver() {
            if (this._domObserver || typeof MutationObserver === 'undefined' || typeof document === 'undefined') return;
            const root = document.documentElement;
            if (!root) return;
            this._domObserver = new MutationObserver(records => {
                const meaningful = records.some(record => {
                    const target = record.target?.nodeType === 1 ? record.target : record.target?.parentElement;
                    return !target?.closest?.(`#${APP.id}-host`);
                });
                if (!meaningful) return;
                this._domRevision += 1;
                this._questionNodeCache = null;
                this._navigationCandidateCache = null;
                _vuePracticeCacheTime = 0;
            });
            this._domObserver.observe(root, {
                childList: true,
                subtree: true,
                characterData: true,
                attributes: true,
                attributeFilter: ['class', 'style', 'hidden', 'aria-current', 'aria-selected', 'aria-checked', 'value'],
            });
        }

        waitForDomCondition(check, { timeout = 5000, interval = 100 } = {}) {
            this.ensureDomObserver();
            return new Promise(resolve => {
                const startedAt = Date.now();
                let settled = false;
                let timer = null;
                let observer = null;

                const finish = value => {
                    if (settled) return;
                    settled = true;
                    if (timer) clearTimeout(timer);
                    observer?.disconnect();
                    resolve(value || null);
                };

                const evaluate = () => {
                    if (settled) return;
                    try {
                        const value = check();
                        if (value) {
                            finish(value);
                            return;
                        }
                    } catch (error) {
                        console.debug('[CXAE] DOM 条件检查失败，继续等待。', error);
                    }
                    if (Date.now() - startedAt >= timeout) {
                        finish(null);
                        return;
                    }
                    timer = setTimeout(evaluate, interval);
                };

                if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined' && document.documentElement) {
                    observer = new MutationObserver(() => {
                        clearTimeout(timer);
                        timer = setTimeout(evaluate, 0);
                    });
                    observer.observe(document.documentElement, {
                        childList: true,
                        subtree: true,
                        characterData: true,
                        attributes: true,
                        attributeFilter: ['class', 'style', 'hidden', 'aria-current', 'aria-selected', 'aria-checked', 'value'],
                    });
                }
                evaluate();
            });
        }

        async waitForAnswer(questionNode, order = 0, timeout = APP.answerGraceTimeout) {
            return this.waitForDomCondition(() => {
                const node = this.getCurrentQuestionNode(order) || questionNode;
                const item = this.parseQuestion(node, order || 0);
                return item?.answer ? { node, item } : null;
            }, { timeout, interval: 80 });
        }

        getScope() {
            const url = new URL(location.href);
            const stable = [];
            const preferredKeys = ['courseId', 'classId', 'tId', 'activeId', 'activePrimaryId', 'quizId'];
            const fallbackKeys = ['testId', 'examId', 'paperId', 'workId', 'relationId', 'id'];

            preferredKeys.forEach(key => {
                const value = url.searchParams.get(key);
                if (value) stable.push(`${key}=${value}`);
            });

            if (!stable.some(item => item.startsWith('tId='))) {
                for (const key of fallbackKeys) {
                    const value = url.searchParams.get(key);
                    if (value) {
                        stable.push(`${key}=${value}`);
                        break;
                    }
                }
            }

            const practice = this.getVuePracticeContext();
            const active = practice?.data?.active;
            const activityId = active?.id || active?.activeId || active?.fid || active?.relationId;
            if (activityId) stable.push(`activityId=${activityId}`);

            if (stable.length) {
                return `${url.origin}?${Array.from(new Set(stable)).sort().join('&')}`;
            }

            const title = normalizeText(
                document.querySelector('.mark_title, .testTit, .exam-title, h1')?.textContent || document.title
            );
            return `${url.origin}${url.pathname}|${title}`;
        }

        getVuePracticeContext() {
            // 同时兼容 Vue 2 的 __vue__ 与 Vue 3 的 __vueParentComponent__。
            const now = Date.now();
            if (_vuePracticeCache && now - _vuePracticeCacheTime < VUE_CACHE_TTL) {
                return _vuePracticeCache;
            }

            const seen = new Set();
            const listKeys = [
                'questionList', 'questions', 'topicList', 'subjectList',
                'paperQuestionList', 'examQuestionList', 'testQuestionList',
                'questionDtos', 'questionVOList', 'allQuestions'
            ];

            const inspectInstance = instance => {
                let current = instance;
                let depth = 0;

                while (current && depth < 40) {
                    if (seen.has(current)) break;
                    seen.add(current);

                    const sources = [];
                    try {
                        sources.push(
                            current.$data,
                            current.proxy?.$data,
                            current.setupState,
                            current.data,
                            current.ctx,
                            current.proxy
                        );
                    } catch { /* 某些 Vue Proxy 属性可能抛错 */ }

                    const usable = sources.filter(source => source && typeof source === 'object');
                    for (const source of usable) {
                        for (const key of listKeys) {
                            let list;
                            try { list = source[key]; } catch { list = null; }
                            if (!Array.isArray(list) || !list.length) continue;

                            let active = null;
                            for (const candidate of usable) {
                                try {
                                    if (candidate.active) {
                                        active = candidate.active;
                                        break;
                                    }
                                } catch { /* ignore */ }
                            }

                            return {
                                vm: current,
                                data: { questionList: list, active },
                                list,
                            };
                        }
                    }

                    current = current.$parent || current.parent || null;
                    depth += 1;
                }
                return null;
            };

            const inspectElement = element => {
                if (!element) return null;
                const instances = [
                    element.__vue__,
                    element.__vueParentComponent,
                    element.__vue_app__?._instance,
                ].filter(Boolean);
                for (const instance of instances) {
                    const result = inspectInstance(instance);
                    if (result) return result;
                }
                return null;
            };

            const quickCheck = document.querySelectorAll(
                '#main, #app, .practice, .quiz, [class*="question"], [class*="exam"], [class*="practice"]'
            );
            for (const element of quickCheck) {
                const result = inspectElement(element);
                if (result) {
                    _vuePracticeCache = result;
                    _vuePracticeCacheTime = now;
                    return result;
                }
            }

            // 快速检查未找到时再进行全页面扫描。
            for (const element of document.querySelectorAll('*')) {
                const result = inspectElement(element);
                if (result) {
                    _vuePracticeCache = result;
                    _vuePracticeCacheTime = now;
                    return result;
                }
            }

            _vuePracticeCache = null;
            _vuePracticeCacheTime = now;
            return null;
        }

        hasVuePracticeQuestions() {
            return Boolean(this.getVuePracticeContext()?.list?.length);
        }

        htmlToText(value) {
            const html = String(value ?? '');
            if (!html) return '';
            const template = document.createElement('template');
            template.innerHTML = html
                .replace(/<br\s*\/?>/gi, '\n')
                .replace(/<\/p\s*>/gi, '</p>\n')
                .replace(/<\/div\s*>/gi, '</div>\n');
            return normalizeText(template.content.textContent || '');
        }

        parseMaybeJson(value, fallback = []) {
            if (Array.isArray(value)) return value;
            if (value && typeof value === 'object') return value;
            if (typeof value !== 'string') return fallback;
            const trimmed = value.trim();
            if (!trimmed) return fallback;
            try {
                return JSON.parse(trimmed);
            } catch {
                return fallback;
            }
        }

        normalizeVueAnswer(value) {
            if (value == null) return '';
            if (typeof value === 'string') {
                const parsed = this.parseMaybeJson(value, null);
                if (parsed !== null) return this.normalizeVueAnswer(parsed);
                return this.htmlToText(value);
            }
            if (Array.isArray(value)) {
                return value
                    .map(item => this.normalizeVueAnswer(item))
                    .filter(Boolean)
                    .join('、');
            }
            if (typeof value === 'object') {
                const candidate = value.content ?? value.answer ?? value.value ?? value.name ?? value.label;
                if (candidate != null) return this.normalizeVueAnswer(candidate);
                return '';
            }
            return normalizeText(value);
        }

        getVueOptionObjects(question) {
            const fromOptions = this.parseMaybeJson(question?.options, []);
            if (Array.isArray(fromOptions) && fromOptions.length) return fromOptions;

            const fromAnswer = question?.answer;
            if (
                Array.isArray(fromAnswer) &&
                fromAnswer.length >= 2 &&
                fromAnswer.every(item => item && typeof item === 'object' && ('content' in item || 'name' in item))
            ) {
                return fromAnswer;
            }
            return [];
        }

        formatVueOptions(question) {
            const result = [];
            const seen = new Set();
            for (const option of this.getVueOptionObjects(question)) {
                const label = normalizeText(option?.name ?? option?.key ?? option?.label ?? option?.code ?? '');
                const content = this.htmlToText(option?.content ?? option?.value ?? option?.text ?? option?.title ?? '');
                if (!label && !content) continue;
                const value = label && content && label !== content
                    ? `${label}. ${content}`
                    : (content || label);
                if (seen.has(value)) continue;
                seen.add(value);
                result.push(value);
            }
            return result;
        }

        inferVueQuestionType(question, options, answer) {
            const rawType = question?.questionTypeName ?? question?.typeName ?? question?.questionType ?? question?.questiontype ?? question?.type;
            if (typeof rawType === 'string' && /题/.test(rawType)) return normalizeText(rawType);

            const optionContents = this.getVueOptionObjects(question)
                .map(option => this.htmlToText(option?.content ?? option?.value ?? option?.text ?? ''))
                .filter(Boolean);
            const judgementSet = new Set(optionContents);
            if (
                optionContents.length === 2 &&
                (judgementSet.has('对') || judgementSet.has('正確') || judgementSet.has('正确')) &&
                (judgementSet.has('错') || judgementSet.has('錯'))
            ) {
                return '判断题';
            }

            if (!options.length) {
                const content = this.htmlToText(question?.content ?? question?.questionContent ?? '');
                return /_{2,}|第\s*\d+\s*空|填空/.test(content) ? '填空题' : '简答题';
            }

            const answerParts = String(answer || '').split(/[、,，;；\s]+/).filter(Boolean);
            return answerParts.length > 1 ? '多选题' : '单选题';
        }

        extractHtmlImages(...values) {
            const result = [];
            const seen = new Set();
            for (const value of values.flat(Infinity)) {
                if (value == null) continue;
                const html = typeof value === 'object'
                    ? String(value.content ?? value.value ?? value.text ?? '')
                    : String(value);
                if (!html || !/<img\b/i.test(html)) continue;
                const template = document.createElement('template');
                template.innerHTML = html;
                template.content.querySelectorAll('img').forEach(image => {
                    const source = image.getAttribute('src') || image.getAttribute('data-src') || image.getAttribute('data-original');
                    if (!source) return;
                    let absolute = source;
                    try { absolute = new URL(source, location.href).href; } catch {}
                    if (seen.has(absolute)) return;
                    seen.add(absolute);
                    result.push(absolute);
                });
            }
            return result;
        }

        parseVuePracticeQuestion(question, fallbackOrder = 0) {
            if (!question || typeof question !== 'object') return null;
            const contentHtml = question.content ?? question.questionContent ?? question.title ?? question.name ?? '';
            const title = this.htmlToText(contentHtml);
            if (!title) return null;

            const options = this.formatVueOptions(question);
            const answer = this.normalizeVueAnswer(
                question.rightAnswer ??
                question.correctAnswer ??
                question.standardAnswer ??
                question.rightOption ??
                question.rightOptions ??
                question.answerContent
            );
            const order = Number(
                question.order ??
                question.sort ??
                question.serialNo ??
                question.questionNo ??
                question.no ??
                fallbackOrder
            ) || fallbackOrder;
            const optionObjects = this.getVueOptionObjects(question);

            return {
                order,
                type: this.inferVueQuestionType(question, options, answer),
                question: title,
                options,
                answer: this.cleanAnswer(answer),
                images: this.extractHtmlImages(contentHtml, optionObjects),
                sourceUrl: location.href,
                source: 'vue-practice',
                sourceId: question.id ?? question.questionId ?? null,
            };
        }

        getVuePracticeItems() {
            const context = this.getVuePracticeContext();
            if (!context) return [];
            return context.list
                .map((question, index) => this.parseVuePracticeQuestion(question, index + 1))
                .filter(Boolean);
        }

        async waitForVuePractice(timeout = APP.questionWaitTimeout) {
            const startedAt = Date.now();
            while (Date.now() - startedAt < timeout) {
                const context = this.getVuePracticeContext();
                if (context?.list?.length) return context;
                await sleep(250);
            }
            return null;
        }

        getQuestionNodes() {
            this.ensureDomObserver();
            const now = Date.now();
            if (
                this._questionNodeCache &&
                this._questionNodeCache.revision === this._domRevision &&
                now - this._questionNodeCache.at <= APP.questionNodeCacheTtl
            ) {
                return this._questionNodeCache.nodes.slice();
            }

            const result = [];
            const seenNodes = new Set();
            const signatures = new Set();
            const answerSelector = [
                'input[type="radio"]',
                'input[type="checkbox"]',
                'input[type="text"]:not([readonly]):not([disabled])',
                'textarea:not([readonly]):not([disabled])',
                '[contenteditable="true"]',
                '[role="radio"]',
                '[role="checkbox"]',
            ].join(',');
            const containerSelector = [
                '.questionLi', '.mark_item',
                '.question-item', '.questionItem',
                '.subject-item', '.subjectItem',
                '.topic-item', '.topicItem',
                '.practice-question', '.practiceQuestion',
                '[data-question-id]', '[data-questionid]',
                '[data-question-index]', '[data-topic-id]',
            ].join(',');

            const candidates = Array.from(document.querySelectorAll(containerSelector));

            // 页面结构没有标准题目容器时，从可作答控件向上寻找最小的题目块。
            if (!candidates.length) {
                const controls = Array.from(document.querySelectorAll(answerSelector))
                    .filter(control => !control.closest?.(`#${APP.id}-host`));

                for (const control of controls) {
                    let container = control.closest(containerSelector);
                    if (!container) {
                        let current = control.parentElement;
                        let fallback = null;
                        for (let depth = 0; current && depth < 9; depth += 1, current = current.parentElement) {
                            if (current === document.body || current === document.documentElement) break;
                            const controlCount = current.querySelectorAll(answerSelector).length;
                            const text = normalizeText(current.innerText || current.textContent || '');
                            if (controlCount >= 1 && text.length >= 6 && text.length <= 12000) fallback = current;
                            if (
                                fallback &&
                                (this.findTitleNode(current) || this.extractQuestionNumber(text) || controlCount >= 2)
                            ) {
                                container = current;
                                break;
                            }
                        }
                        container ||= fallback;
                    }
                    if (container) candidates.push(container);
                }
            }

            // 优先保留更小、更接近控件的题目容器，避免把整张试卷当成一道题。
            const uniqueCandidates = Array.from(new Set(candidates))
                .filter(node => node?.isConnected && !node.closest?.(`#${APP.id}-host`))
                .sort((left, right) => {
                    const leftControls = left.querySelectorAll(answerSelector).length;
                    const rightControls = right.querySelectorAll(answerSelector).length;
                    if (leftControls !== rightControls) return leftControls - rightControls;
                    return normalizeText(left.textContent).length - normalizeText(right.textContent).length;
                });

            for (const node of uniqueCandidates) {
                if (seenNodes.has(node)) continue;
                if (result.some(existing => node.contains(existing))) continue;

                const titleNode = this.findTitleNode(node);
                const title = normalizeText(titleNode?.textContent || '');
                const text = title || normalizeText(node.innerText || node.textContent || '').slice(0, 500);
                if (!text) continue;

                const nodeIndex = result.length;
                const order = this.extractQuestionNumber(title) ||
                    this.extractQuestionNumber(node.innerText || node.textContent) ||
                    (nodeIndex + 1);
                const signature = `${order}|${text.slice(0, 120)}`;
                if (signatures.has(signature)) continue;

                signatures.add(signature);
                seenNodes.add(node);
                result.push(node);
            }

            const sorted = result.sort((left, right) => {
                if (left === right) return 0;
                const position = left.compareDocumentPosition(right);
                return position & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
            });
            this._questionNodeCache = {
                revision: this._domRevision,
                at: Date.now(),
                nodes: sorted.slice(),
            };
            return sorted;
        }

        hasQuestions() {
            if (this.hasVuePracticeQuestions() || this.getQuestionNodes().length > 0) return true;
            return Boolean(document.querySelector(
                'input[type="radio"], input[type="checkbox"], textarea, input[type="text"], [contenteditable="true"], .ql-editor, .ProseMirror, .w-e-text, [role="radio"], [role="checkbox"]'
            ));
        }

        findTitleNode(question) {
            return question?.querySelector(
                '.question-name, [class*="question-name"], .questionName, ' +
                '.mark_name, [class*="mark_name"], ' +
                '.question-title, .questionTitle, ' +
                '.subject-title, .subjectTitle, ' +
                '.topic-title, .topicTitle, ' +
                '.stem, [class*="question-stem"], [class*="subject-title"], [class*="topic-title"]'
            ) || null;
        }

        findQuestionNodeForItem(item, nodes = this.getQuestionNodes(), used = new Set()) {
            if (!item || !nodes?.length) return null;
            const sourceId = item.sourceId == null ? '' : String(item.sourceId);

            if (sourceId) {
                const idAttributes = ['data-question-id', 'data-questionid', 'data-id', 'data-topic-id', 'questionid'];
                for (const node of nodes) {
                    if (used.has(node)) continue;
                    const matched = idAttributes.some(attribute => String(node.getAttribute?.(attribute) || '') === sourceId) ||
                        Array.from(node.querySelectorAll?.('[data-question-id], [data-questionid], [data-id], [data-topic-id], [questionid]') || [])
                            .some(element => idAttributes.some(attribute => String(element.getAttribute(attribute) || '') === sourceId));
                    if (matched) return node;
                }
            }

            const normalizeQuestionText = value => normalizeText(value || '')
                .replace(/^\d+\s*[.、．]\s*/, '')
                .replace(/^[\[【（(]\s*[^\]】）)]*(?:题|題)[^\]】）)]*[\]】）)]\s*/, '')
                .replace(/[\s ]+/g, '');
            const targetQuestion = normalizeQuestionText(item.question || '');
            const snippet = targetQuestion.slice(0, 36);
            let matchedByText = null;

            if (snippet) {
                for (const node of nodes) {
                    if (used.has(node)) continue;
                    const parsed = this.parseQuestion(node, 0);
                    const nodeQuestion = normalizeQuestionText(parsed?.question || node.innerText || node.textContent || '');
                    if (nodeQuestion.includes(snippet) || targetQuestion.includes(nodeQuestion.slice(0, 36))) {
                        matchedByText = node;
                        break;
                    }
                }
                if (matchedByText) return matchedByText;

                // 题干明确但当前页面没有匹配时，不再只按题号硬塞答案。
                // 这能避免“第5题其实是填空题，却拿到旧的单选 A”这种错位回填。
                if (targetQuestion.length >= 16) return null;
            }

            const targetOrder = Number(item.order) || 0;
            if (targetOrder > 0) {
                for (const node of nodes) {
                    if (used.has(node)) continue;
                    const nodeOrder = this.extractQuestionNumber(node.innerText || node.textContent || '');
                    if (nodeOrder === targetOrder) return node;
                }
            }

            return nodes.find(node => !used.has(node)) || null;
        }

        getAnswerTargets() {
            const nodes = this.getQuestionNodes();
            const vueItems = this.getVuePracticeItems();

            if (vueItems.length) {
                const used = new Set();
                return vueItems.map((item, index) => {
                    const node = this.findQuestionNodeForItem(item, nodes, used) || nodes[index] || null;
                    if (node) used.add(node);
                    return { node, item };
                }).filter(target => target.node && target.item);
            }

            return nodes.map((node, index) => ({
                node,
                item: this.parseQuestion(node, index + 1),
            })).filter(target => target.item);
        }

        isQuestionNodeVisible(node) {
            if (!node) return false;
            if (isVisible(node)) return true;
            const controls = node.querySelectorAll?.(
                'input, textarea, iframe, [contenteditable="true"], .ql-editor, .ProseMirror, .w-e-text, [role="radio"], [role="checkbox"], button, a'
            ) || [];
            return Array.from(controls).some(isVisible);
        }

        getVisibleQuestionNodes() {
            return this.getQuestionNodes().filter(node => this.isQuestionNodeVisible(node));
        }

        getCurrentQuestionNode(expectedOrder = 0) {
            const nodes = this.getQuestionNodes();
            if (!nodes.length) return null;
            const visible = nodes.filter(node => this.isQuestionNodeVisible(node));
            const candidates = visible.length ? visible : nodes;
            const targetOrder = Number(expectedOrder) || this.getActiveQuestionNumber();

            if (targetOrder > 0) {
                const matched = candidates.find(node => {
                    const parsed = this.parseQuestion(node, 0);
                    return Number(parsed?.order) === targetOrder;
                });
                if (matched) return matched;
            }
            return candidates[0] || null;
        }

        getVisibleAnswerTargets() {
            const targets = this.getAnswerTargets();
            const visible = targets.filter(target => this.isQuestionNodeVisible(target.node));
            if (visible.length) return visible;
            return targets.length === 1 ? targets : [];
        }

        getCurrentAnswerTarget() {
            const targets = this.getVisibleAnswerTargets();
            if (!targets.length) return null;
            const currentOrder = this.getCurrentOrder();
            const target = targets.find(candidate => Number(candidate.item?.order) === currentOrder) || targets[0];
            if (!target?.item) return null;
            return {
                node: target.node,
                item: {
                    ...target.item,
                    order: Number(target.item.order) || currentOrder || 0,
                },
            };
        }

        getQuestionSignature() {
            const target = this.getVisibleAnswerTargets()[0];
            const order = this.getCurrentOrder();
            if (!target?.item) return order ? `order:${order}` : '';
            const question = normalizeText(target.item.question || '').slice(0, 180);
            const options = (target.item.options || []).map(normalizeText).join('|').slice(0, 220);
            return `${order}|${question}|${options}`;
        }

        getLines(question) {
            return String(question?.innerText || question?.textContent || '')
                .split('\n')
                .map(normalizeText)
                .filter(Boolean);
        }

        extractQuestionNumber(value) {
            const text = String(value || '').replace(/\r/g, '');
            const patterns = [
                /(?:^|\n)\s*(\d{1,5})\s*[.、．]\s*(?:[（(][^）)\n]*题[^）)\n]*[）)]\s*)?/,
                /(?:^|\n)\s*第\s*(\d{1,5})\s*题(?:\s|$|[：:])/,
                /^\s*(\d{1,5})\s*[.、．]/,
            ];

            for (const pattern of patterns) {
                const match = text.match(pattern);
                const number = Number(match?.[1]);
                if (Number.isFinite(number) && number > 0) return number;
            }
            return 0;
        }

        normalizeQuestionType(value) {
            const text = normalizeText(value);
            const map = {
                '單選題': '单选题',
                '单选題': '单选题',
                '單选题': '单选题',
                '多選題': '多选题',
                '多选題': '多选题',
                '多選题': '多选题',
                '判斷題': '判断题',
                '判断題': '判断题',
                '判斷题': '判断题',
                '填空題': '填空题',
                '簡答題': '简答题',
                '简答題': '简答题',
                '論述題': '论述题',
                '论述題': '论述题',
            };
            return map[text] || text.replace(/題/g, '题');
        }

        inferQuestionType(title) {
            const text = String(title || '');
            const match =
                text.match(/[（(]\s*([^）)]+题)\s*[）)]/) ||
                text.match(/[\[【]\s*([^\]】]+(?:题|題))\s*[\]】]/);
            return match ? this.normalizeQuestionType(match[1]) : '未分类';
        }

        getLabeledSection(question, label, stopLabels = []) {
            const lines = this.getLines(question);
            const index = lines.findIndex(line => line.startsWith(label));
            if (index < 0) return '';

            const values = [];
            const sameLine = normalizeText(lines[index].slice(label.length).replace(/^[:：]\s*/, ''));
            if (sameLine) values.push(sameLine);

            for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
                if (stopLabels.some(stop => lines[cursor].startsWith(stop))) break;
                values.push(lines[cursor]);
            }
            return values.join('\n').trim();
        }

        cleanAnswer(value) {
            return String(value || '')
                .replace(/\u00a0/g, ' ')
                .replace(/^\s*(?:正确答案|正確答案|参考答案|參考答案|标准答案|標準答案)\s*[:：]?\s*/i, '')
                .replace(/\s*(?:答案解析|答案詳解|答案详解|题目解析|題目解析|难易度|難易度|知识点|知識點)\s*[:：]?.*$/s, '')
                .replace(/[ \t]+/g, ' ')
                .trim();
        }

        extractAnswer(question) {
            const selectors = [
                '.mark_answer .colorGreen',
                '.correctAnswer',
                '.rightAnswer',
                '.correct-answer',
                '.right-answer',
                '.answerRight',
                '.answer-right',
                '.correct_answer',
                '[class*="correct"][class*="answer"]',
                '[class*="right"][class*="answer"]',
            ];

            for (const selector of selectors) {
                for (const element of question.querySelectorAll(selector)) {
                    const value = this.cleanAnswer(element.textContent);
                    if (value && value !== '正确答案') return value;
                }
            }

            const answerLabels = ['正确答案', '正確答案', '参考答案', '參考答案', '标准答案', '標準答案'];
            const stopLabels = ['答案解析', '答案詳解', '答案详解', '题目解析', '題目解析', '难易度', '難易度', '知识点', '知識點', '上一题', '上一題', '下一题', '下一題'];
            for (const answerLabel of answerLabels) {
                const labeled = this.cleanAnswer(this.getLabeledSection(question, answerLabel, stopLabels));
                if (labeled) return labeled;
            }

            const fullText = String(question.innerText || question.textContent || '').replace(/\r/g, '');
            const lineMatch = fullText.match(/(?:^|\n)\s*(?:正确答案|正確答案|参考答案|參考答案|标准答案|標準答案)\s*[:：]\s*([^\n]+)/);
            if (lineMatch) {
                const value = this.cleanAnswer(lineMatch[1]);
                if (value) return value;
            }

            const labelPattern = /^(?:正确答案|正確答案|参考答案|參考答案|标准答案|標準答案)\s*[:：]?$/;
            const labels = Array.from(question.querySelectorAll('span, div, p, i, b, strong'))
                .filter(element => labelPattern.test(normalizeText(element.textContent)));

            for (const label of labels) {
                let sibling = label.nextElementSibling;
                for (let index = 0; sibling && index < 4; index += 1, sibling = sibling.nextElementSibling) {
                    const value = this.cleanAnswer(sibling.textContent);
                    if (value) return value;
                }

                const parentMatch = String(label.parentElement?.innerText || '').match(/(?:正确答案|正確答案|参考答案|參考答案|标准答案|標準答案)\s*[:：]?\s*([^\n]+)/);
                const value = this.cleanAnswer(parentMatch?.[1]);
                if (value) return value;
            }

            return '';
        }

        extractOptions(question) {
            const selectors = [
                '.mark_letter li',
                '.answerList li',
                '.answer-list li',
                '.question-options li',
                '.option-list li',
                '.options li',
                '.option-item',
                '.optionItem',
                '.answer-option',
                '.answerItem',
            ];
            const options = [];
            const seen = new Set();

            selectors.forEach(selector => {
                question.querySelectorAll(selector).forEach(element => {
                    const value = normalizeText(element.innerText || element.textContent);
                    if (value && !seen.has(value)) {
                        seen.add(value);
                        options.push(value);
                    }
                });
            });

            if (!options.length) {
                this.getLines(question).forEach(line => {
                    if (/^[A-HＡ-Ｈ]\s*[.、．:：)）]\s*\S+/.test(line) && !seen.has(line)) {
                        seen.add(line);
                        options.push(line);
                    }
                });
            }

            // mobilelearn 题目页常把选项渲染成多行：A / 选项内容 / B / 选项内容，
            // 而不是 “A. 选项内容”。这里补一层分行识别。
            if (!options.length) {
                const lines = this.getLines(question);
                for (let index = 0; index < lines.length; index += 1) {
                    const letter = this.normalizeOptionLetter(lines[index]).match(/^([A-H])$/)?.[1];
                    if (!letter) continue;

                    const parts = [];
                    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
                        const nextLetter = this.normalizeOptionLetter(lines[cursor]).match(/^([A-H])$/)?.[1];
                        if (nextLetter) break;
                        if (/^第\s*\d+\s*空/.test(lines[cursor])) break;
                        if (/^(我的答案|正确答案|正確答案|参考答案|參考答案|标准答案|標準答案|答案解析|答案詳解|题目解析|題目解析)/.test(lines[cursor])) break;
                        parts.push(lines[cursor]);
                    }

                    const value = `${letter}. ${parts.join(' ')}`.trim();
                    if (parts.length && !seen.has(value)) {
                        seen.add(value);
                        options.push(value);
                    }
                }
            }

            return options;
        }

        extractImages(question) {
            const result = [];
            const seen = new Set();
            question.querySelectorAll('img').forEach(image => {
                const source = image.currentSrc || image.src || image.getAttribute('src');
                if (!source || source.startsWith('data:') || seen.has(source)) return;
                seen.add(source);
                result.push(source);
            });
            return result;
        }

        inferQuestionTypeFromNode(question, title = '') {
            let type = this.inferQuestionType(title || this.findTitleNode(question)?.textContent || '');
            const blankInputs = question?.querySelectorAll?.('input.ofl-ipt, input[type="text"].ofl-ipt, input[type="text"][class*="blank"], input[type="text"][class*="fill"]') || [];
            if (blankInputs.length) return '填空题';

            // mobilelearn 的判断题通常没有 radio，只有两个 li 文本“对/错”或“對/錯”。
            const options = this.getOptionElements?.(question) || [];
            const optionTexts = options.map(option => normalizeText(option.innerText || option.textContent || '')
                .replace(/^[A-HＡ-Ｈ]\s*[.、．:：)）]?\s*/, '')
            ).filter(Boolean);
            const judgementWords = optionTexts.filter(text => /^(对|對|正确|正確|√|是|T|True|Yes|错|錯|错误|錯誤|×|否|F|False|No)$/i.test(text));
            if (judgementWords.length >= 2) return '判断题';
            return type;
        }

        parseQuestion(question, fallbackOrder = 0) {
            if (!question) return null;
            const titleNode = this.findTitleNode(question);
            let title = normalizeText(titleNode?.innerText || titleNode?.textContent);

            if (!title) {
                const lines = this.getLines(question);
                title = lines.find(line => !/^(我的答案|正確答案|正确答案|答案解析|题目解析|難易度|难易度|知识点|知識點)/.test(line)) || '';
            }
            if (!title) return null;

            const order = this.extractQuestionNumber(title) ||
                this.extractQuestionNumber(question.innerText || question.textContent) ||
                fallbackOrder;
            const options = this.extractOptions(question);

            return {
                order,
                type: this.inferQuestionTypeFromNode(question, title),
                question: title,
                options,
                answer: this.extractAnswer(question),
                images: this.extractImages(question),
                sourceUrl: location.href,
            };
        }

        detectMode() {
            if (this.hasVuePracticeQuestions()) return 'practice-vue';

            const nodes = this.getQuestionNodes();
            const visibleNodes = nodes.filter(node => this.isQuestionNodeVisible(node));
            const visibleQuestionKeys = new Set();
            visibleNodes.forEach((node, index) => {
                const item = this.parseQuestion(node, index + 1);
                if (!item) return;
                const key = Number(item.order) > 0
                    ? `order:${Number(item.order)}`
                    : `question:${normalizeText(item.question).slice(0, 120)}`;
                visibleQuestionKeys.add(key);
            });
            const visibleQuestionCount = visibleQuestionKeys.size || visibleNodes.length;
            const navigationNumbers = this.getQuestionNavigationNumbers();
            const total = this.detectTotal();
            const hasDirectionalNavigation = Boolean(
                this.findNavigation('下一题') || this.findNavigation('上一题')
            );

            // 逐题页面经常会把其他题目的隐藏 DOM、选项容器或答题卡一起放在页面中。
            // 旧逻辑只要检测到多个节点就误判为“长卷同页”，从而只扫描当前 DOM。
            // 现在只把“多个不同的可见题目”视为长卷；存在明确翻页控件时优先逐题模式。
            if (total > 1 && hasDirectionalNavigation) return 'paged';
            if ((total > 1 || navigationNumbers.length >= 2) && visibleQuestionCount <= 1 && navigationNumbers.length >= 2) {
                return 'paged';
            }
            if (visibleQuestionCount > 1) return 'long-page';
            if (nodes.length > 1 && !hasDirectionalNavigation && navigationNumbers.length < 2) return 'long-page';
            return 'paged';
        }

        detectTotal() {
            const text = String(document.body?.innerText || '');
            const values = [];
            const patterns = [
                /共\s*(\d+)\s*题/g,
                /题量\s*[:：]\s*(\d+)/g,
                /总题数\s*[:：]\s*(\d+)/g,
            ];

            for (const pattern of patterns) {
                for (const match of text.matchAll(pattern)) {
                    const value = Number(match[1]);
                    if (Number.isFinite(value) && value > 0) values.push(value);
                }
            }

            const navNumbers = this.getQuestionNavigationNumbers();
            if (navNumbers.length >= 3) values.push(Math.max(...navNumbers));

            const practiceCount = this.getVuePracticeContext()?.list?.length || 0;
            if (practiceCount) values.push(practiceCount);

            return values.length ? Math.max(...values) : 0;
        }

        getActiveQuestionNumber() {
            const candidates = Array.from(document.querySelectorAll(
                '[aria-current="true"], [aria-selected="true"], a.active, button.active, .current, .cur, .selected, .on'
            ));
            const scored = [];

            for (const element of candidates) {
                if (!isVisible(element)) continue;
                const text = normalizeText(element.textContent);
                if (!/^\d{1,5}$/.test(text)) continue;

                const container = element.parentElement?.parentElement || element.parentElement;
                const numericCount = container
                    ? Array.from(container.querySelectorAll('a, button, [onclick], [role="button"]'))
                        .filter(node => /^\d{1,5}$/.test(normalizeText(node.textContent))).length
                    : 0;
                if (numericCount < 5) continue;

                let score = numericCount;
                if (/active|current|cur|selected|on/i.test(String(element.className || ''))) score += 20;
                if (element.getAttribute('aria-current') === 'true' || element.getAttribute('aria-selected') === 'true') score += 30;
                scored.push({ value: Number(text), score });
            }

            scored.sort((left, right) => right.score - left.score);
            return scored[0]?.value || 0;
        }

        getCurrentOrder() {
            const active = this.getActiveQuestionNumber();
            const navigationNumbers = active > 0 ? this.getQuestionNavigationNumbers() : [];
            if (active > 0 && navigationNumbers.includes(active)) return active;

            const question = this.getCurrentQuestionNode(active);
            const parsed = question ? this.parseQuestion(question) : null;
            return Number(parsed?.order) || active || 0;
        }

        findTextAction(label, root = document) {
            const clickableSelector = 'a, button, input, [role="button"], [onclick]';
            const nodes = Array.from(root.querySelectorAll(`${clickableSelector}, span, div`));
            const seen = new Set();
            const candidates = [];

            for (const node of nodes) {
                if (node.closest?.(`#${APP.id}-host`)) continue;
                const text = node.tagName === 'INPUT'
                    ? normalizeText(node.value)
                    : normalizeText(node.innerText || node.textContent);
                if (!(text === label || (text.includes(label) && text.length <= label.length + 4))) continue;

                const clickable = node.matches(clickableSelector) ? node : node.closest(clickableSelector);
                if (!clickable || !root.contains(clickable) || seen.has(clickable) || !isVisible(clickable) || isDisabled(clickable)) continue;
                seen.add(clickable);

                let score = 0;
                if (text === label) score += 5;
                if (['A', 'BUTTON', 'INPUT'].includes(clickable.tagName)) score += 3;
                if (clickable.hasAttribute('onclick')) score += 2;
                if (clickable.closest('.questionLi, .mark_item')) score += 2;
                candidates.push({ element: clickable, score });
            }

            candidates.sort((left, right) => right.score - left.score);
            return candidates[0]?.element || null;
        }

        findShowAnswer(question = null) {
            return this.findTextAction('显示答案', question || document);
        }

        findNavigation(label) {
            const aliases = {
                '下一题': ['下一题', '下题', '后一题', '下一页', '下一步', '下一个'],
                '上一题': ['上一题', '上题', '前一题', '上一页', '上一个'],
            };
            const labels = aliases[label] || [label];
            for (const candidate of labels) {
                const action = this.findTextAction(candidate);
                if (action) return action;
            }

            // 部分新版页面只在 aria-label/title 中标注翻页含义，按钮正文是图标。
            const attributePattern = label === '下一题'
                ? /下一题|下题|后一题|下一页|下一步|下一个|next/i
                : label === '上一题'
                    ? /上一题|上题|前一题|上一页|上一个|previous|prev/i
                    : new RegExp(String(label), 'i');
            const candidates = Array.from(document.querySelectorAll(
                'a, button, input[type="button"], input[type="submit"], [role="button"], [onclick]'
            ));
            for (const element of candidates) {
                if (element.closest?.(`#${APP.id}-host`) || !isVisible(element) || isDisabled(element)) continue;
                const hint = [
                    element.getAttribute?.('aria-label'),
                    element.getAttribute?.('title'),
                    element.getAttribute?.('data-title'),
                    element.getAttribute?.('name'),
                    element.getAttribute?.('rel'),
                    element.id,
                    element.className,
                    element.getAttribute?.('onclick'),
                    element.tagName === 'INPUT' ? element.value : '',
                ].filter(Boolean).join(' ');
                if (attributePattern.test(normalizeText(hint))) return element;
            }
            return null;
        }

        findQuestionNavigationTarget(targetOrder, currentOrder = 0) {
            const target = Number(targetOrder) || 0;
            const current = Number(currentOrder) || this.getCurrentOrder();
            if (target > 0) {
                const direct = this.findNumberButton(target);
                if (direct) return { element: direct, targetOrder: target, method: 'number' };
            }

            if (target > current || !(current > 0)) {
                const next = this.findNavigation('下一题');
                if (next) return { element: next, targetOrder: target || current + 1, method: 'next' };
            }
            if (target > 0 && target < current) {
                const previous = this.findNavigation('上一题');
                if (previous) return { element: previous, targetOrder: target, method: 'previous' };
            }

            // 最后尝试答题卡中当前题之后最近的题号。
            const later = this.getQuestionNavigationNumbers().find(number => number > current);
            if (later) {
                const direct = this.findNumberButton(later);
                if (direct) return { element: direct, targetOrder: later, method: 'number-fallback' };
            }
            return null;
        }

        getQuestionNumberCandidates(number = null) {
            this.ensureDomObserver();
            const targetNumber = number == null ? null : Number(number);
            const now = Date.now();
            if (
                this._navigationCandidateCache &&
                this._navigationCandidateCache.revision === this._domRevision &&
                now - this._navigationCandidateCache.at <= APP.navigationCacheTtl
            ) {
                const cached = this._navigationCandidateCache.candidates;
                return (targetNumber == null ? cached : cached.filter(candidate => candidate.number === targetNumber)).slice();
            }
            const selector = [
                'a', 'button', 'input[type="button"]', 'input[type="submit"]',
                '[role="button"]', '[onclick]', 'li',
                '[data-question-index]', '[data-question-number]', '[data-index]', '[data-num]',
                '[class*="question-num"]', '[class*="questionNum"]',
                '[class*="topic-num"]', '[class*="topicNum"]',
                '[class*="answer-card"]', '[class*="answerCard"]',
                '[class*="subject-num"]', '[class*="subjectNum"]',
                '[class*="number"]', '[class*="Number"]'
            ].join(',');
            const result = [];
            const seen = new Set();

            for (const node of document.querySelectorAll(selector)) {
                if (node.closest?.(`#${APP.id}-host`) || !isVisible(node)) continue;
                const text = node.tagName === 'INPUT'
                    ? normalizeText(node.value)
                    : normalizeText(node.innerText || node.textContent);
                if (!/^\d{1,5}$/.test(text)) continue;

                let element = node;
                const standardClickable = node.matches?.('a, button, input, [role="button"], [onclick]')
                    ? node
                    : node.closest?.('a, button, input, [role="button"], [onclick]');
                if (standardClickable && normalizeText(
                    standardClickable.tagName === 'INPUT' ? standardClickable.value : standardClickable.innerText || standardClickable.textContent
                ) === text) {
                    element = standardClickable;
                }
                if (seen.has(element) || isDisabled(element)) continue;
                seen.add(element);

                const className = String(element.className || '');
                const onclick = String(element.getAttribute?.('onclick') || '');
                const style = getComputedStyle(element);
                const rect = element.getBoundingClientRect();
                let score = 0;
                if (element.matches?.('a, button, input, [role="button"], [onclick]')) score += 4;
                if (style.cursor === 'pointer') score += 2;
                if (/question|answer|topic|subject|num|number|index|card|catalog|nav/i.test(className)) score += 4;
                if (/getThe|question|exam|test|topic|subject|change/i.test(onclick)) score += 4;
                if (rect.width <= 140 && rect.height <= 100) score += 1;

                let ancestor = element.parentElement;
                for (let depth = 0; ancestor && depth < 5; depth += 1, ancestor = ancestor.parentElement) {
                    if (ancestor.closest?.(`#${APP.id}-host`)) break;
                    const lines = String(ancestor.innerText || ancestor.textContent || '')
                        .split('\n').map(normalizeText).filter(value => /^\d{1,5}$/.test(value));
                    const uniqueCount = new Set(lines).size;
                    const ancestorClass = String(ancestor.className || '');
                    if (uniqueCount >= 3) score += uniqueCount >= 8 ? 6 : 4;
                    if (/answer|question|topic|subject|card|catalog|nav|number|num/i.test(ancestorClass)) score += 2;
                    if (uniqueCount >= 3) break;
                }

                result.push({ element, number: Number(text), score });
            }

            const sorted = result.sort((left, right) => right.score - left.score);
            this._navigationCandidateCache = {
                revision: this._domRevision,
                at: Date.now(),
                candidates: sorted.slice(),
            };
            return (targetNumber == null ? sorted : sorted.filter(candidate => candidate.number === targetNumber)).slice();
        }

        getQuestionNavigationNumbers() {
            const candidates = this.getQuestionNumberCandidates()
                .filter(candidate => candidate.score >= 5)
                .map(candidate => candidate.number)
                .filter(value => Number.isFinite(value) && value > 0);
            return Array.from(new Set(candidates)).sort((left, right) => left - right);
        }

        findNumberButton(number) {
            const candidates = this.getQuestionNumberCandidates(number);
            return candidates.length && candidates[0].score >= 5 ? candidates[0].element : null;
        }

        isSafeInlineReveal(button) {
            if (!button) return false;
            const href = String(button.getAttribute('href') || '').trim();
            if (href && !/^(?:#|javascript:|javascript:void\(0\);?)$/i.test(href)) return false;
            const onclick = String(button.getAttribute('onclick') || '');
            return !/window\.location|location\s*[.=]|window\.open|document\.location|submit\s*\(|getTheNextQuestion/i.test(onclick);
        }

        async waitForQuestion(timeout = APP.questionWaitTimeout) {
            return this.waitForDomCondition(() => {
                const node = this.getCurrentQuestionNode();
                return node && normalizeText(node.textContent) ? node : null;
            }, { timeout, interval: 90 });
        }

        async waitForStableCurrentOrder(timeout = APP.questionWaitTimeout) {
            let last = 0;
            let stableSince = 0;
            const value = await this.waitForDomCondition(() => {
                const current = this.getCurrentOrder();
                if (!(current > 0)) return null;
                if (current !== last) {
                    last = current;
                    stableSince = Date.now();
                    return null;
                }
                return Date.now() - stableSince >= APP.domSettleDelay ? current : null;
            }, { timeout, interval: 45 });
            return Number(value) || last;
        }

        async waitForQuestionSwitch(previousSignature = '', targetOrder = 0, timeout = APP.aiNavigationTimeout) {
            let readySince = 0;
            let readyKey = '';
            const result = await this.waitForDomCondition(() => {
                const currentOrder = this.getCurrentOrder();
                const signature = this.getQuestionSignature();
                const orderMatched = Number(targetOrder) > 0 && currentOrder === Number(targetOrder);
                const contentChanged = Boolean(signature && previousSignature && signature !== previousSignature);
                const ready = orderMatched || contentChanged || (!previousSignature && Boolean(signature));
                if (!ready) {
                    readySince = 0;
                    readyKey = '';
                    return null;
                }
                const key = `${currentOrder}|${signature}`;
                if (key !== readyKey) {
                    readyKey = key;
                    readySince = Date.now();
                    return null;
                }
                return Date.now() - readySince >= APP.domSettleDelay ? true : null;
            }, { timeout, interval: 45 });
            return Boolean(result);
        }

        getPaperTitle() {
            const practiceTitle = this.getVuePracticeContext()?.data?.active?.name;
            return normalizeText(
                practiceTitle || document.querySelector('.mark_title, .testTit, .exam-title, h1')?.textContent || document.title
            ).replace(/[-_|]\s*超星.*$/i, '') || '超星题目';
        }

        // ---- 自动答题：DOM 填充方法 ----

        isUsableTextControl(element, allowHidden = false) {
            if (!element || !element.isConnected || element.closest?.(`#${APP.id}-host`)) return false;
            if (element.matches?.('[disabled], [readonly], [contenteditable="false"]')) return false;
            if (String(element.tagName || '').toUpperCase() === 'INPUT' && /^(?:hidden|button|submit|reset|file|radio|checkbox)$/i.test(element.type || 'text')) return false;
            if (allowHidden) return true;
            if (element.ownerDocument !== document) return true;
            return isVisible(element);
        }

        getFrameEditorBodies(root) {
            const result = [];
            const seen = new Set();
            for (const iframe of Array.from(root?.querySelectorAll?.('iframe') || [])) {
                if (iframe.closest?.(`#${APP.id}-host`)) continue;
                try {
                    const frameDocument = iframe.contentDocument || iframe.contentWindow?.document;
                    if (!frameDocument?.body) continue;
                    const frameHint = `${iframe.id || ''} ${iframe.name || ''} ${iframe.className || ''} ${iframe.src || ''}`;
                    const editorHint = /editor|ueditor|ckeditor|wysiwyg|tinymce|tox|mce|quill|answer|textarea/i.test(frameHint);
                    const candidates = Array.from(frameDocument.querySelectorAll(
                        '[contenteditable="true"], textarea:not([readonly]):not([disabled]), input[type="text"]:not([readonly]):not([disabled]), .ql-editor, .ProseMirror, .w-e-text'
                    ));
                    if (!candidates.length && (frameDocument.body.isContentEditable || editorHint)) {
                        candidates.push(frameDocument.body);
                    }
                    for (const candidate of candidates) {
                        if (seen.has(candidate)) continue;
                        seen.add(candidate);
                        result.push(candidate);
                    }
                } catch (error) {
                    console.debug('[CXAE] 无法访问富文本 iframe，可能是跨域编辑器。', error);
                }
            }
            return result;
        }

        getNearbyTextControls(questionNode) {
            const selector = [
                'textarea:not([readonly]):not([disabled])',
                'input[type="text"]:not([readonly]):not([disabled])',
                'input:not([type]):not([readonly]):not([disabled])',
                '[contenteditable="true"]',
                '.ql-editor', '.ProseMirror', '.w-e-text',
                '[class*="answer"] textarea', '[class*="answer"] input[type="text"]',
                '[class*="blank"] input[type="text"]', '[class*="editor"] [contenteditable="true"]'
            ].join(',');
            const questionContainerSelector = [
                '.questionLi', '.mark_item',
                '.question-item', '.questionItem',
                '.subject-item', '.subjectItem',
                '.topic-item', '.topicItem',
                '.practice-question', '.practiceQuestion',
                '[data-question-id]', '[data-questionid]',
                '[data-question-index]', '[data-topic-id]'
            ].join(',');
            const seen = new Set();
            const result = [];

            const addElement = element => {
                if (!element || seen.has(element) || !this.isUsableTextControl(element)) return;
                seen.add(element);
                result.push(element);
            };
            const addFrom = root => {
                for (const element of Array.from(root?.querySelectorAll?.(selector) || [])) addElement(element);
                for (const element of this.getFrameEditorBodies(root)) addElement(element);
            };

            // questionNode 有时只是题干或第一个空的局部节点。先回到最近的完整题目容器，
            // 一次收集该题全部输入框，不能在找到第一个控件后立即返回。
            const questionScope = questionNode?.matches?.(questionContainerSelector)
                ? questionNode
                : questionNode?.closest?.(questionContainerSelector);
            addFrom(questionScope || questionNode);

            if (!questionScope) {
                // 没有标准题目容器时，逐层扩大范围。若某一层开始包含多个明显题目块，
                // 只保留与当前题目在同一子块中的控件，避免把下一题的输入框带进来。
                let ancestor = questionNode?.parentElement;
                for (let depth = 0; ancestor && depth < 5 && ancestor !== document.body; depth += 1, ancestor = ancestor.parentElement) {
                    const nestedQuestions = Array.from(ancestor.querySelectorAll(questionContainerSelector));
                    if (nestedQuestions.length > 1) break;
                    addFrom(ancestor);
                }
            }

            // 某些新版页面把多个填空框或富文本编辑器挂在题目容器的同级节点。
            // 用题目矩形和控件提示筛选，并收集所有匹配项，而不是只取第一个。
            const questionRect = (questionScope || questionNode)?.getBoundingClientRect?.();
            const documentCandidates = Array.from(document.querySelectorAll(selector));
            for (const element of documentCandidates) {
                if (seen.has(element) || !this.isUsableTextControl(element)) continue;

                const ownerQuestion = element.closest?.(questionContainerSelector);
                if (questionScope && ownerQuestion && ownerQuestion !== questionScope) continue;

                const hint = `${element.id || ''} ${element.className || ''} ${element.getAttribute?.('name') || ''} ${element.getAttribute?.('placeholder') || ''}`;
                if (!/answer|blank|editor|content|subject|question|reply|textarea|fill|填空|答案|作答|请输入|第\s*\d+\s*空/i.test(hint)) continue;
                if (questionRect) {
                    const rect = element.getBoundingClientRect();
                    const verticallyNear = rect.bottom >= questionRect.top - 100 && rect.top <= questionRect.bottom + 900;
                    const horizontallyOverlaps = rect.right >= questionRect.left - 100 && rect.left <= questionRect.right + 100;
                    if (!verticallyNear || !horizontallyOverlaps) continue;
                }
                addElement(element);
            }

            // 保持页面中的自然顺序，确保第 N 个答案写入第 N 个空。
            return result.sort((left, right) => {
                if (left === right) return 0;
                if (left.ownerDocument === right.ownerDocument && left.compareDocumentPosition) {
                    const position = left.compareDocumentPosition(right);
                    if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
                    if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
                }
                const leftRect = left.getBoundingClientRect?.() || { top: 0, left: 0 };
                const rightRect = right.getBoundingClientRect?.() || { top: 0, left: 0 };
                return leftRect.top - rightRect.top || leftRect.left - rightRect.left;
            });
        }
        findAnswerInputs(questionNode) {
            if (!questionNode) {
                return { radios: [], checkboxes: [], textInputs: [], textareas: [], contentEditables: [], textControls: [] };
            }
            const radios = Array.from(questionNode.querySelectorAll('input[type="radio"], [role="radio"]'));
            const checkboxes = Array.from(questionNode.querySelectorAll('input[type="checkbox"], [role="checkbox"]'));
            const textControls = this.getNearbyTextControls(questionNode);
            const textInputs = textControls.filter(element => String(element.tagName || '').toUpperCase() === 'INPUT');
            const textareas = textControls.filter(element => String(element.tagName || '').toUpperCase() === 'TEXTAREA');
            const contentEditables = textControls.filter(element => !textInputs.includes(element) && !textareas.includes(element));
            return { radios, checkboxes, textInputs, textareas, contentEditables, textControls };
        }

        getOptionElements(questionNode) {
            if (!questionNode) return [];
            const selectors = [
                '.mark_letter li', '.answerList li', '.answer-list li',
                '.question-options li', '.option-list li', '.options li',
                '.option-item', '.answer-option', '.optionItem', '.answerItem',
                '[class*="option-item"]', '[class*="answer-item"]',
                '[role="radio"]', '[role="checkbox"]',
            ];
            const result = [];
            const seen = new Set();
            const add = element => {
                if (!element || seen.has(element) || element.closest?.(`#${APP.id}-host`)) return;
                const text = normalizeText(element.innerText || element.textContent || '');
                const hasOptionLetter = Boolean(element.querySelector?.('.option-letter, [class*="option-letter"], [class*="optionLetter"]'));
                const isRoleChoice = element.matches?.('[role="radio"], [role="checkbox"]');
                const looksLikeOption = hasOptionLetter || isRoleChoice || /^[A-HＡ-Ｈ]\s*[.、．:：)）]?\s*\S+/.test(text);
                if (!looksLikeOption) return;
                seen.add(element);
                result.push(element);
            };

            for (const selector of selectors) {
                questionNode.querySelectorAll(selector).forEach(add);
            }

            // mobilelearn 新版常见结构：<li><span class="option-letter">A</span><p class="option-result">...</p></li>
            // 这些 li 没有 option/answer 类，也没有 radio input；只能靠 option-letter 识别。
            questionNode.querySelectorAll('li').forEach(add);
            questionNode.querySelectorAll('.option-letter, [class*="option-letter"], [class*="optionLetter"]').forEach(letter => {
                add(letter.closest?.('li') || letter.parentElement);
            });

            return result;
        }

        normalizeOptionLetter(value) {
            return normalizeText(value)
                .replace(/[Ａ-Ｚ]/g, character => String.fromCharCode(character.charCodeAt(0) - 0xFEE0))
                .toUpperCase();
        }

        getChoiceTarget(optionElement, preferredType = '') {
            if (!optionElement) return null;
            if (optionElement.matches?.('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]')) {
                return optionElement;
            }
            const typeSelector = preferredType === 'checkbox'
                ? 'input[type="checkbox"], [role="checkbox"]'
                : preferredType === 'radio'
                    ? 'input[type="radio"], [role="radio"]'
                    : 'input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]';
            const nestedInput = optionElement.querySelector(typeSelector);
            if (nestedInput) return nestedInput;

            // mobilelearn 选项没有 input，点击 li 才会触发页面自己的选中逻辑。
            const mobileLi = optionElement.matches?.('li')
                ? optionElement
                : optionElement.closest?.('li');
            if (mobileLi?.querySelector?.('.option-letter, [class*="option-letter"], [class*="optionLetter"]')) return mobileLi;

            return optionElement.closest('label, [role="radio"], [role="checkbox"]') || optionElement;
        }

        getChoiceState(element) {
            if (!element) return null;
            if (element instanceof HTMLInputElement && /^(radio|checkbox)$/i.test(element.type)) {
                return Boolean(element.checked);
            }
            const ariaChecked = element.getAttribute?.('aria-checked');
            if (ariaChecked === 'true') return true;
            if (ariaChecked === 'false') return false;
            const selectedClassPattern = /(^|\s)(checked|selected|select|is-checked|is-selected|active|on|cur|current|choose|chosen)(\s|$)/i;
            const unselectedClassPattern = /(^|\s)(unchecked|unselected|unselect)(\s|$)/i;
            const className = String(element.className || '');
            if (selectedClassPattern.test(className)) return true;
            if (unselectedClassPattern.test(className)) return false;
            const selectedChild = element.querySelector?.('.checked, .selected, .is-checked, .is-selected, .active, .on, .cur, .current, .choose, .chosen');
            if (selectedChild) return true;
            const nestedInput = element.querySelector?.('input[type="radio"], input[type="checkbox"]');
            if (nestedInput) return Boolean(nestedInput.checked);
            return null;
        }

        triggerChoiceClick(element) {
            if (!element) return false;
            try { element.scrollIntoView?.({ block: 'center', inline: 'nearest' }); } catch { /* ignore */ }
            const ownerWindow = element.ownerDocument?.defaultView || window;
            const eventNames = ['pointerdown', 'mousedown', 'touchstart', 'pointerup', 'mouseup', 'touchend', 'click'];
            for (const name of eventNames) {
                try {
                    const event = /^touch/.test(name)
                        ? new ownerWindow.Event(name, { bubbles: true, cancelable: true, composed: true })
                        : new ownerWindow.MouseEvent(name, { bubbles: true, cancelable: true, composed: true, view: ownerWindow });
                    element.dispatchEvent(event);
                } catch {
                    try { element.dispatchEvent(new Event(name, { bubbles: true, cancelable: true })); } catch { /* ignore */ }
                }
            }
            try { element.click?.(); } catch { /* some synthetic elements may reject click */ }
            return true;
        }

        setChoiceState(element, desired) {
            if (!element || isDisabled(element)) return false;
            const targetState = Boolean(desired);

            if (element instanceof HTMLInputElement && /^(radio|checkbox)$/i.test(element.type)) {
                if (element.checked === targetState) return true;

                try { this.triggerChoiceClick(element); } catch { /* fallback below */ }
                if (element.checked === targetState) return true;

                const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set;
                if (setter) setter.call(element, targetState);
                else element.checked = targetState;
                element.dispatchEvent(new Event('input', { bubbles: true }));
                element.dispatchEvent(new Event('change', { bubbles: true }));
                return element.checked === targetState;
            }

            const before = this.getChoiceState(element);
            if (before === targetState) return true;
            if (targetState || before === true) {
                if (!this.triggerChoiceClick(element)) return false;
            }
            const after = this.getChoiceState(element);
            // mobilelearn 的 li 选项有时不会暴露 selected class，只能信任页面点击事件。
            return after === targetState || (after === null && targetState);
        }

        getOptionLetterMap(questionNode) {
            const map = new Map();
            if (!questionNode) return map;

            const optionElements = this.getOptionElements(questionNode);
            optionElements.forEach((option, index) => {
                const text = normalizeText(option.innerText || option.textContent || '');
                const match = this.normalizeOptionLetter(text).match(/^([A-H])\s*[.、．:：)）]?/);
                const letter = match?.[1] || (index < 8 ? String.fromCharCode(65 + index) : '');
                if (!letter || map.has(letter)) return;
                const target = this.getChoiceTarget(option);
                if (target) map.set(letter, target);
            });

            if (!map.size) {
                const { radios, checkboxes } = this.findAnswerInputs(questionNode);
                const choices = checkboxes.length ? checkboxes : radios;
                choices.forEach((choice, index) => {
                    if (index < 8) map.set(String.fromCharCode(65 + index), choice);
                });
            }
            return map;
        }

        getJudgementMap(questionNode) {
            const result = { true: null, false: null };
            if (!questionNode) return result;

            const truePattern = /^(对|對|正确|正確|√|是|T|True|Yes)$/i;
            const falsePattern = /^(错|錯|错误|錯誤|×|否|F|False|No)$/i;
            const options = this.getOptionElements(questionNode);
            const normalizedOptions = [];
            for (const option of options) {
                const rawText = normalizeText(option.innerText || option.textContent || '');
                const text = rawText.replace(/^[A-HＡ-Ｈ]\s*[.、．:：)）]?\s*/, '').trim();
                const target = this.getChoiceTarget(option, 'radio');
                if (!target || !text) continue;
                normalizedOptions.push({ option, text, target });
                if (truePattern.test(text)) result.true = target;
                else if (falsePattern.test(text)) result.false = target;
            }

            // mobilelearn 判断题如果选项文字被富文本包裹，可能只匹配到父 li。
            // 常规顺序是 A=对/正确，B=错/错误；找不到显式文字时按两个选项兜底。
            if ((!result.true || !result.false) && normalizedOptions.length === 2) {
                if (!result.true && truePattern.test(normalizedOptions[0].text)) result.true = normalizedOptions[0].target;
                if (!result.false && falsePattern.test(normalizedOptions[1].text)) result.false = normalizedOptions[1].target;
                if (!result.true && !result.false) {
                    result.true = normalizedOptions[0].target;
                    result.false = normalizedOptions[1].target;
                }
            }

            const { radios } = this.findAnswerInputs(questionNode);
            if (!result.true && !result.false && radios.length >= 2) {
                result.true = radios[0];
                result.false = radios[1];
            }
            return result;
        }

        fillQuestion(questionNode, answer, type) {
            this.lastFillError = '';
            if (!questionNode || !normalizeText(answer)) return false;
            const storedType = normalizeText(type || '');
            const titleText = normalizeText(this.findTitleNode(questionNode)?.innerText || this.findTitleNode(questionNode)?.textContent || questionNode.innerText || questionNode.textContent || '');
            const liveType = this.inferQuestionTypeFromNode(questionNode, titleText);
            const cleanType = liveType && liveType !== '未分类' ? liveType : storedType;
            const { radios, checkboxes, textInputs, textareas, contentEditables } = this.findAnswerInputs(questionNode);
            const optionElements = this.getOptionElements(questionNode);
            const hasBlankInputs = textInputs.length || textareas.length || contentEditables.length || Boolean(questionNode.querySelector?.('input.ofl-ipt'));
            const hasChoiceOptions = radios.length || checkboxes.length || optionElements.length >= 2;
            const answerIsJudgement = /^(对|對|正确|正確|√|错|錯|错误|錯誤|×|是|否|T|F|True|False|Yes|No)$/i.test(normalizeText(answer).replace(/[。.!！]/g, ''));

            // 优先相信当前 DOM 的真实控件，而不是旧 session/AI 里缓存的题型。
            // 例如 mobilelearn 有时第 N 题题型缓存为“单选题”，但当前节点实际是 .ofl-ipt 填空。
            if (/填空/.test(cleanType) || (hasBlankInputs && !hasChoiceOptions)) return this.fillBlank(questionNode, answer);
            if (/判断/.test(cleanType) || (answerIsJudgement && optionElements.length <= 2)) return this.fillJudgement(questionNode, answer);
            if (/多选/.test(cleanType)) return this.fillMultipleChoice(questionNode, answer);
            if (/单选/.test(cleanType)) return this.fillSingleChoice(questionNode, answer);
            if (/简答|论述|问答|名词解释|解释题|材料分析|案例分析|翻译|写作|计算题/.test(cleanType)) return this.fillEssay(questionNode, answer);

            if (checkboxes.length) return this.fillMultipleChoice(questionNode, answer);
            if (radios.length) return answerIsJudgement ? this.fillJudgement(questionNode, answer) : this.fillSingleChoice(questionNode, answer);
            if (hasBlankInputs) return this.fillBlank(questionNode, answer);

            // 旧 session 里题型可能是“未分类”，但 mobilelearn 单选/多选没有 radio input，
            // 只能通过 li.option-letter 这种自定义选项来回填。
            if (optionElements.length >= 2) {
                const normalizedAnswer = this.normalizeOptionLetter(answer);
                const letters = Array.from(new Set(Array.from(normalizedAnswer.matchAll(/[A-H]/g), match => match[0])));
                if (answerIsJudgement) return this.fillJudgement(questionNode, answer);
                return letters.length > 1 ? this.fillMultipleChoice(questionNode, answer) : this.fillSingleChoice(questionNode, answer);
            }

            this.lastFillError = `未识别到可回填控件；当前DOM题型=${cleanType || '未知'}，缓存题型=${storedType || '未知'}`;
            return false;
        }

        fillSingleChoice(questionNode, answer) {
            const letterMap = this.getOptionLetterMap(questionNode);
            const normalizedAnswer = this.normalizeOptionLetter(answer);
            const letter = normalizedAnswer.match(/(?:答案\s*[:：]?\s*)?([A-H])/)?.[1];
            if (letter && letterMap.has(letter)) {
                return this.setChoiceState(letterMap.get(letter), true);
            }
            return this.fillByOptionText(questionNode, answer, 'radio');
        }

        fillMultipleChoice(questionNode, answer) {
            const letterMap = this.getOptionLetterMap(questionNode);
            const normalizedAnswer = this.normalizeOptionLetter(answer);
            const letters = Array.from(new Set(Array.from(normalizedAnswer.matchAll(/[A-H]/g), match => match[0])));
            if (!letters.length) return this.fillByOptionText(questionNode, answer, 'checkbox');

            const desired = new Set(letters);
            for (const [letter, target] of letterMap) {
                this.setChoiceState(target, desired.has(letter));
            }
            return letters.every(letter => letterMap.has(letter) && this.getChoiceState(letterMap.get(letter)) !== false);
        }

        fillJudgement(questionNode, answer) {
            const judgementMap = this.getJudgementMap(questionNode);
            const text = normalizeText(answer).replace(/[。.!！]/g, '');
            const isTrue = /^(对|對|正确|正確|√|是|T|True|yes)$/i.test(text);
            const isFalse = /^(错|錯|错误|錯誤|×|否|F|False|no)$/i.test(text);
            if (isTrue && judgementMap.true) return this.setChoiceState(judgementMap.true, true);
            if (isFalse && judgementMap.false) return this.setChoiceState(judgementMap.false, true);
            return false;
        }

        dispatchTextEvent(element, type, data = null, inputType = 'insertText', cancelable = false) {
            try {
                const EventConstructor = element.ownerDocument?.defaultView?.InputEvent || InputEvent;
                return element.dispatchEvent(new EventConstructor(type, {
                    bubbles: true,
                    cancelable,
                    composed: true,
                    data,
                    inputType,
                }));
            } catch {
                return element.dispatchEvent(new Event(type, { bubbles: true, cancelable }));
            }
        }

        setKnownEditorValue(element, value) {
            const targetValue = String(value ?? '');
            const ownerDocument = element?.ownerDocument;
            if (!ownerDocument) return false;
            let frame = null;
            if (ownerDocument !== document) {
                frame = Array.from(document.querySelectorAll('iframe')).find(candidate => {
                    try { return candidate.contentDocument === ownerDocument; } catch { return false; }
                }) || null;
            }

            try {
                const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
                const tinyEditors = Array.from(pageWindow?.tinymce?.editors || []);
                const tinyEditor = tinyEditors.find(editor => editor?.iframeElement === frame || editor?.getBody?.() === element);
                if (tinyEditor) {
                    tinyEditor.setContent(targetValue.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>'));
                    tinyEditor.fire?.('input');
                    tinyEditor.fire?.('change');
                    return normalizeText(tinyEditor.getContent?.({ format: 'text' }) || '') === normalizeText(targetValue);
                }

                const ckInstances = Object.values(pageWindow?.CKEDITOR?.instances || {});
                const ckEditor = ckInstances.find(editor => editor?.document?.$ === ownerDocument || editor?.window?.$ === frame?.contentWindow);
                if (ckEditor) {
                    ckEditor.setData(targetValue.replace(/\n/g, '<br>'));
                    ckEditor.fire?.('change');
                    return true;
                }

                const ueInstances = Object.values(pageWindow?.UE?.instants || pageWindow?.UE?.instances || {});
                const ueEditor = ueInstances.find(editor => editor?.iframe === frame || editor?.document === ownerDocument || editor?.body === element);
                if (ueEditor?.setContent) {
                    ueEditor.setContent(targetValue.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>'));
                    ueEditor.fireEvent?.('contentchange');
                    return true;
                }
            } catch (error) {
                console.debug('[CXAE] 富文本编辑器 API 写入失败，改用 DOM 输入。', error);
            }
            return false;
        }

        syncEditorMirror(element, value) {
            const ownerDocument = element?.ownerDocument;
            if (!ownerDocument) return;
            let container = element;
            if (ownerDocument !== document) {
                const frame = Array.from(document.querySelectorAll('iframe')).find(candidate => {
                    try { return candidate.contentDocument === ownerDocument; } catch { return false; }
                });
                container = frame?.parentElement || frame || element;
            }
            const scope = container?.closest?.('[class*="editor"], [class*="answer"], [class*="question"], [class*="subject"]') || container?.parentElement;
            for (const mirror of Array.from(scope?.querySelectorAll?.('textarea, input[type="hidden"]') || [])) {
                if (mirror === element || mirror.disabled || mirror.readOnly) continue;
                try {
                    const mirrorWindow = mirror.ownerDocument?.defaultView || window;
                    const prototype = String(mirror.tagName || '').toUpperCase() === 'TEXTAREA'
                        ? mirrorWindow.HTMLTextAreaElement?.prototype
                        : mirrorWindow.HTMLInputElement?.prototype;
                    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
                    if (setter) setter.call(mirror, String(value ?? ''));
                    else mirror.value = String(value ?? '');
                    mirror.dispatchEvent(new Event('input', { bubbles: true }));
                    mirror.dispatchEvent(new Event('change', { bubbles: true }));
                } catch { /* mirror is only a best-effort fallback */ }
            }
        }

        setNativeValue(element, value) {
            if (!element) return false;
            const targetValue = String(value ?? '');
            this.lastFillError = '';

            if (this.setKnownEditorValue(element, targetValue)) {
                this.syncEditorMirror(element, targetValue);
                return true;
            }

            const isEditable = element.getAttribute?.('contenteditable') === 'true' ||
                element.isContentEditable ||
                /^(?:BODY|DIV|P)$/i.test(element.tagName || '') &&
                    /editor|wysiwyg|ql-editor|ProseMirror|w-e-text|mce-content-body/i.test(`${element.id || ''} ${element.className || ''}`);

            if (isEditable) {
                try {
                    const ownerDocument = element.ownerDocument || document;
                    element.focus?.();
                    const selection = ownerDocument.getSelection?.();
                    if (selection) {
                        const range = ownerDocument.createRange();
                        range.selectNodeContents(element);
                        selection.removeAllRanges();
                        selection.addRange(range);
                    }

                    this.dispatchTextEvent(element, 'beforeinput', targetValue, 'insertText', true);
                    let inserted = false;
                    try {
                        inserted = Boolean(ownerDocument.execCommand?.('insertText', false, targetValue));
                    } catch { /* use DOM fallback */ }
                    if (!inserted || normalizeText(element.innerText || element.textContent || '') !== normalizeText(targetValue)) {
                        element.textContent = targetValue;
                    }
                    this.dispatchTextEvent(element, 'input', targetValue, 'insertText');
                    element.dispatchEvent(new Event('change', { bubbles: true }));
                    element.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
                    element.blur?.();
                    this.syncEditorMirror(element, targetValue);
                    const actual = normalizeText(element.innerText || element.textContent || '');
                    if (actual === normalizeText(targetValue)) return true;
                    this.lastFillError = '富文本编辑器写入后内容未保留';
                    return false;
                } catch (error) {
                    this.lastFillError = `富文本编辑器写入失败：${error?.message || String(error)}`;
                    return false;
                }
            }

            const elementTag = String(element.tagName || '').toUpperCase();
            if (!(elementTag === 'INPUT' || elementTag === 'TEXTAREA')) {
                this.lastFillError = '未识别到可写入的文本控件';
                return false;
            }

            try {
                const ownerDocument = element.ownerDocument || document;
                const elementWindow = ownerDocument.defaultView || window;
                const prototype = elementTag === 'TEXTAREA'
                    ? elementWindow.HTMLTextAreaElement?.prototype
                    : elementWindow.HTMLInputElement?.prototype;
                const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
                const assign = nextValue => {
                    if (setter) setter.call(element, nextValue);
                    else element.value = nextValue;
                    // mobilelearn 的 .ofl-ipt 有时在提交时读取 attribute，而不只读 property。
                    try { element.setAttribute('value', nextValue); } catch { /* ignore */ }
                };
                const emit = (eventName, init = {}) => {
                    try {
                        const Constructor = eventName.startsWith('key') ? elementWindow.KeyboardEvent : elementWindow.Event;
                        element.dispatchEvent(new Constructor(eventName, { bubbles: true, cancelable: true, composed: true, ...init }));
                    } catch {
                        element.dispatchEvent(new Event(eventName, { bubbles: true, cancelable: true }));
                    }
                };

                try { element.scrollIntoView?.({ block: 'center', inline: 'nearest' }); } catch { /* ignore */ }
                element.focus?.();
                emit('focusin');
                emit('focus');

                const previousValue = String(element.value || '');
                element._valueTracker?.setValue?.(previousValue);

                this.dispatchTextEvent(element, 'beforeinput', null, 'deleteContentBackward', true);
                assign('');
                this.dispatchTextEvent(element, 'input', null, 'deleteContentBackward');
                emit('keyup', { key: 'Backspace' });

                // 对 mobilelearn 的填空框不要只一次性改 value，而是按字符模拟输入，
                // 因为它经常用 keyup/input 里的临时值更新内部答案数组。
                let currentValue = '';
                for (const character of Array.from(targetValue)) {
                    emit('keydown', { key: character });
                    emit('keypress', { key: character });
                    this.dispatchTextEvent(element, 'beforeinput', character, 'insertText', true);
                    currentValue += character;
                    assign(currentValue);
                    try { element.setSelectionRange?.(currentValue.length, currentValue.length); } catch { /* ignore */ }
                    this.dispatchTextEvent(element, 'input', character, 'insertText');
                    emit('keyup', { key: character });
                }

                // 再做一次最终同步，防止受控输入在逐字过程中丢字符。
                assign(targetValue);
                this.dispatchTextEvent(element, 'input', targetValue, 'insertText');
                element.dispatchEvent(new Event('change', { bubbles: true }));
                try { element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: targetValue })); } catch { /* ignore */ }

                // 兼容页面内 jQuery/Zepto 监听。没有就静默跳过。
                try {
                    const pageWindow = elementWindow || (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window);
                    const jq = pageWindow?.jQuery || pageWindow?.$;
                    if (typeof jq === 'function') {
                        jq(element).val(targetValue).trigger('input').trigger('keyup').trigger('change').trigger('blur');
                    }
                } catch { /* ignore */ }

                this.syncEditorMirror(element, targetValue);
                emit('blur');
                emit('focusout');
                element.blur?.();

                if (String(element.value) === targetValue) return true;
                // 有些受控输入会在 blur 后把 property 清空，但 attribute/内部状态已被事件写入。
                // 若 attribute 保留了目标值，也视为写入成功。
                if (String(element.getAttribute?.('value') || '') === targetValue) return true;
                this.lastFillError = `文本框写入后只保留了 ${String(element.value || '').length}/${targetValue.length} 个字符`;
                return false;
            } catch (error) {
                this.lastFillError = `文本框写入失败：${error?.message || String(error)}`;
                return false;
            }
        }

        splitBlankAnswers(answer, expectedCount = 1) {
            const text = String(answer ?? '').trim();
            if (!text) return [];

            const cleanPart = value => normalizeText(value)
                // 只清理“第1空：”“1空：”“空1：”“(1)”这类空位编号。
                // 旧逻辑把“16”“0.156%”“1/2”这种真正答案开头的数字也删掉，
                // 导致多空答案被判定为空，最后整串塞进第 1 空。
                .replace(/^第\s*(?:[一二三四五六七八九十百]+|\d+)\s*空\s*[.、:：)）\]】-]?\s*/, '')
                .replace(/^(?:[一二三四五六七八九十百]+|\d+)\s*空\s*[.、:：)）\]】-]?\s*/, '')
                .replace(/^空\s*(?:[一二三四五六七八九十百]+|\d+)\s*[.、:：)）\]】-]?\s*/, '')
                .replace(/^[（(\[]\s*(?:[一二三四五六七八九十百]+|\d+)\s*[）)\]]\s*/, '')
                .replace(/^(?:[一二三四五六七八九十百]+|\d+)\s*[、:：)）\]】-]\s*/, '')
                .replace(/^\d+\s*\.(?!\d)\s*/, '')
                .replace(/[，,、;；|｜]+\s*$/, '')
                .trim();
            const normalizeParts = values => values.map(cleanPart).filter(value => value !== '');

            try {
                const parsed = JSON.parse(text);
                if (Array.isArray(parsed)) return normalizeParts(parsed);
                if (Array.isArray(parsed?.answer)) return normalizeParts(parsed.answer);
                if (Array.isArray(parsed?.answers)) return normalizeParts(parsed.answers);
                // 兼容 {"第1空":"甲","第2空":"乙"} / {"1":"甲","2":"乙"} / {"blank1":"甲"}
                if (parsed && typeof parsed === 'object') {
                    const entries = Object.entries(parsed)
                        .filter(([key, value]) => value != null && /(?:第?\s*\d+\s*空|blank\s*\d+|^\d+$|空\s*\d+)/i.test(String(key)))
                        .sort(([left], [right]) => {
                            const ln = Number(String(left).match(/\d+/)?.[0] || 0);
                            const rn = Number(String(right).match(/\d+/)?.[0] || 0);
                            return ln - rn;
                        })
                        .map(([, value]) => value);
                    if (entries.length) return normalizeParts(entries);
                }
            } catch { /* plain text answer */ }

            const labelStrippedText = text
                .replace(/^\s*(?:最终答案|正确答案|正確答案|参考答案|參考答案|答案|answer)\s*[:：]\s*/i, '')
                .trim();

            if (expectedCount <= 1) return [normalizeText(labelStrippedText || text)];

            const sourceText = labelStrippedText || text;

            // “第1空：甲；第2空：乙”、"(1)甲 (2)乙" 等带编号格式。
            const numberedPattern = /(?:(?:第\s*)?(?:[一二三四五六七八九十百]+|\d+)\s*空|空\s*(?:[一二三四五六七八九十百]+|\d+)|[（(\[]\s*(?:[一二三四五六七八九十百]+|\d+)\s*[）)\]])\s*[.、:：)）\]】-]?\s*/g;
            const numberedMatches = Array.from(sourceText.matchAll(numberedPattern));
            if (numberedMatches.length >= 2) {
                const parts = numberedMatches.map((match, index) => {
                    const start = Number(match.index) + match[0].length;
                    const end = index + 1 < numberedMatches.length ? Number(numberedMatches[index + 1].index) : sourceText.length;
                    return sourceText.slice(start, end);
                });
                const normalized = normalizeParts(parts);
                if (normalized.length >= expectedCount) return normalized;
            }

            const splitCandidates = [
                // 竖线是最常见的多空答案分隔符，兼容半角 | 和全角 ｜。
                sourceText.split(/\s*[|｜]\s*/),
                sourceText.split(/\r?\n+/),
                sourceText.split(/[;；]+/)
            ];
            for (const values of splitCandidates) {
                const parts = normalizeParts(values);
                if (parts.length >= expectedCount) return parts;
            }

            // 对 “1/2 和 1/2”“伴性 和 一” 这类显式连接词做谨慎拆分；
            // 只有数量刚好等于空数才采用，避免误拆普通短语。
            for (const separator of [/\s+(?:和|及|与|and)\s+/i, /\s+(?:，|,)\s*/]) {
                const parts = normalizeParts(sourceText.split(separator));
                if (parts.length === expectedCount) return parts;
            }

            // 模型或已采集答案常用逗号、顿号分隔。只有分段数与空数一致时才采用，
            // 避免把单个答案中的普通逗号误拆开。
            for (const separator of [/[，,]+/, /[、]+/]) {
                const parts = normalizeParts(sourceText.split(separator));
                if (parts.length === expectedCount) return parts;
            }

            // 兼容“1. 甲 2. 乙”写在同一行的格式。
            const inlineNumbered = sourceText.split(/\s+(?=(?:第\s*)?(?:\d+|[一二三四五六七八九十百]+)\s*空?\s*[.、:：)）-])/);
            const inlineParts = normalizeParts(inlineNumbered);
            if (inlineParts.length >= expectedCount) return inlineParts;

            // 兼容 “甲 乙” 这种只用空格分隔的多空答案。仅在数量刚好时采用，避免误拆长文本。
            const whitespaceParts = normalizeParts(sourceText.split(/\s+/));
            if (whitespaceParts.length === expectedCount) return whitespaceParts;

            return [normalizeText(sourceText)];
        }
        fillBlank(questionNode, answer) {
            const { textInputs, textareas, contentEditables, textControls } = this.findAnswerInputs(questionNode);
            const seen = new Set();
            const inputs = [];
            const addInput = input => {
                if (!input || seen.has(input) || input.closest?.(`#${APP.id}-host`)) return;
                if (!this.isUsableTextControl(input)) return;
                seen.add(input);
                inputs.push(input);
            };
            // mobilelearn 填空框就是 .ofl-ipt，无 id/name，必须显式兜底。
            Array.from(questionNode?.querySelectorAll?.('input.ofl-ipt, input[type="text"].ofl-ipt') || []).forEach(addInput);
            (textControls?.length ? textControls : [...textInputs, ...textareas, ...contentEditables]).forEach(addInput);

            if (!inputs.length) {
                this.lastFillError = '未识别到填空输入框或富文本编辑器';
                return false;
            }

            const parts = this.splitBlankAnswers(answer, inputs.length);
            if (!parts.length) {
                this.lastFillError = 'AI 未返回填空答案';
                return false;
            }
            let filled = 0;
            inputs.forEach((input, index) => {
                const value = parts[index] ?? (inputs.length === 1 ? parts.join('|') : '');
                if (!value) return;
                if (this.setNativeValue(input, value)) filled += 1;
            });
            if (filled === inputs.length) return true;
            if (inputs.length > 1 && parts.length < inputs.length) {
                this.lastFillError = `识别到 ${inputs.length} 个空，但只解析出 ${parts.length} 个答案：${String(answer).slice(0, 80)}`;
            } else {
                this.lastFillError ||= `只成功填写 ${filled}/${inputs.length} 个空`;
            }
            return false;
        }

        fillEssay(questionNode, answer) {
            const { textareas, textInputs, contentEditables, textControls } = this.findAnswerInputs(questionNode);
            const input = textareas[0] || contentEditables[0] || textInputs[0] || textControls?.[0];
            if (!input) {
                this.lastFillError = '未识别到问答题输入框或富文本编辑器';
                return false;
            }
            return this.setNativeValue(input, answer);
        }

        fillByOptionText(questionNode, answer, inputType = 'radio') {
            const answerText = normalizeText(answer).toLowerCase();
            if (!answerText) return false;

            for (const option of this.getOptionElements(questionNode)) {
                const text = normalizeText(option.innerText || option.textContent || '');
                const contentOnly = text.replace(/^[A-HＡ-Ｈ]\s*[.、．:：)）]?\s*/, '');
                if (!contentOnly) continue;
                const normalizedContent = contentOnly.toLowerCase();
                if (!answerText.includes(normalizedContent) && !normalizedContent.includes(answerText)) continue;
                const target = this.getChoiceTarget(option, inputType);
                if (target && this.setChoiceState(target, true)) return true;
            }
            return false;
        }
    }

    class SessionStore {
        constructor(adapter) {
            this.adapter = adapter;
        }

        get key() {
            return `${APP.sessionPrefix}${simpleHash(this.adapter.getScope())}`;
        }

        create(mode) {
            return {
                version: APP.storageVersion,
                scope: this.adapter.getScope(),
                paperTitle: this.adapter.getPaperTitle(),
                active: false,
                mode,
                phase: 'idle',
                total: this.adapter.detectTotal(),
                items: [],
                skipped: [],
                processedOrders: [],
                revealAttempts: {},
                jumpAttempts: {},
                targetOrder: null,
                pendingAnswerOrder: null,
                lastOrder: 0,
                lastAction: '',
                lastActionAt: 0,
                createdAt: Date.now(),
                updatedAt: Date.now(),
            };
        }

        load() {
            try {
                const raw = localStorage.getItem(this.key);
                if (!raw) return null;
                const session = JSON.parse(raw);
                if (!session || session.version !== APP.storageVersion) return null;
                session.items = Array.isArray(session.items) ? session.items : [];
                session.skipped = Array.isArray(session.skipped) ? session.skipped : [];
                session.processedOrders = Array.isArray(session.processedOrders) ? session.processedOrders : [];
                session.revealAttempts = session.revealAttempts && typeof session.revealAttempts === 'object' ? session.revealAttempts : {};
                session.jumpAttempts = session.jumpAttempts && typeof session.jumpAttempts === 'object' ? session.jumpAttempts : {};

                // 兼容旧版数据：旧版无答案题只保存在 skipped 中，未进入 items。
                // 迁移后至少保留题号和题干；新版采集会额外保存题型、选项和图片。
                for (const skipped of session.skipped) {
                    const order = Number(skipped?.order) || 0;
                    const question = normalizeText(skipped?.question || '');
                    const exists = session.items.some(item => {
                        if (order > 0 && Number(item?.order) === order) return true;
                        return !order && question && normalizeText(item?.question || '') === question;
                    });
                    if (!exists && (order > 0 || question)) {
                        session.items.push({
                            order,
                            type: '未分类',
                            question,
                            options: [],
                            answer: '',
                            images: [],
                            sourceUrl: '',
                            answerStatus: 'missing',
                            missingAnswerReason: skipped?.reason || '未读取到正确答案',
                        });
                    }
                }
                session.items.sort((left, right) => (left.order || 0) - (right.order || 0));
                return session;
            } catch (error) {
                console.error('[CXAE] 读取采集进度失败。', error);
                return null;
            }
        }

        save(session) {
            session.version = APP.storageVersion;
            session.scope = this.adapter.getScope();
            session.paperTitle ||= this.adapter.getPaperTitle();
            session.updatedAt = Date.now();
            try {
                localStorage.setItem(this.key, JSON.stringify(session));
                return true;
            } catch (error) {
                console.error('[CXAE] 保存采集进度失败。', error);
                return false;
            }
        }

        clear() {
            localStorage.removeItem(this.key);
        }

        stats(session = this.load()) {
            if (!session) return { questionCount: 0, answerCount: 0, skippedCount: 0, processedCount: 0, total: 0 };
            const processed = new Set((session.processedOrders || []).map(Number).filter(value => value > 0));
            session.items.forEach(item => { if (Number(item.order) > 0) processed.add(Number(item.order)); });
            session.skipped.forEach(item => { if (Number(item.order) > 0) processed.add(Number(item.order)); });
            return {
                questionCount: session.items.filter(item => normalizeText(item.question)).length,
                answerCount: session.items.filter(item => normalizeText(item.answer)).length,
                skippedCount: session.skipped.length,
                processedCount: processed.size,
                total: session.total || 0,
            };
        }

        firstMissing(session) {
            const processed = new Set((session.processedOrders || []).map(Number).filter(value => value > 0));
            session.items.forEach(item => { if (Number(item.order) > 0) processed.add(Number(item.order)); });
            session.skipped.forEach(item => { if (Number(item.order) > 0) processed.add(Number(item.order)); });
            const total = session.total || this.adapter.detectTotal();

            if (total > 0) {
                for (let order = 1; order <= total; order += 1) {
                    if (!processed.has(order)) return order;
                }
                return total + 1;
            }
            return processed.size ? Math.max(...processed) + 1 : 1;
        }

        addItem(session, item) {
            const hasAnswer = Boolean(normalizeText(item?.answer));
            const normalizedItem = {
                ...item,
                answer: item?.answer == null ? '' : String(item.answer),
                answerStatus: hasAnswer ? 'answered' : 'missing',
            };
            if (hasAnswer) delete normalizedItem.missingAnswerReason;

            const itemKey = normalizedItem.order
                ? `order:${normalizedItem.order}`
                : `question:${normalizedItem.question}`;
            const index = session.items.findIndex(existing => {
                const existingKey = existing.order ? `order:${existing.order}` : `question:${existing.question}`;
                return existingKey === itemKey;
            });
            if (index >= 0) session.items[index] = normalizedItem;
            else session.items.push(normalizedItem);
            session.items.sort((left, right) => (left.order || 0) - (right.order || 0));

            // 后续重新采集到答案时，自动移除原来的“暂无答案”记录。
            if (hasAnswer) {
                session.skipped = session.skipped.filter(record => {
                    if (Number(normalizedItem.order) > 0) return Number(record.order) !== Number(normalizedItem.order);
                    return normalizeText(record.question) !== normalizeText(normalizedItem.question);
                });
            }
            this.markProcessed(session, normalizedItem.order);
        }

        addSkipped(session, item, reason) {
            const order = Number(item?.order) || 0;
            const missingReason = reason || '未读取到正确答案';

            // 无答案也要保存完整题目；skipped 仅用于记录“暂无答案”的状态和原因。
            this.addItem(session, {
                ...(item || {}),
                order,
                answer: '',
                answerStatus: 'missing',
                missingAnswerReason: missingReason,
            });

            const record = { order, question: item?.question || '', reason: missingReason };
            const index = session.skipped.findIndex(existing => {
                if (order > 0) return Number(existing.order) === order;
                return normalizeText(existing.question) === normalizeText(record.question);
            });
            if (index >= 0) session.skipped[index] = record;
            else session.skipped.push(record);
            this.markProcessed(session, order);
        }

        markProcessed(session, order) {
            const value = Number(order);
            if (!(value > 0)) return;
            session.processedOrders = Array.from(new Set([...(session.processedOrders || []), value])).sort((a, b) => a - b);
        }
    }

    class Exporter {
        constructor(store, settingsStore) {
            this.store = store;
            this.settingsStore = settingsStore;
        }

        getItems() {
            const session = this.store.load();
            return (session?.items || [])
                .filter(item => normalizeText(item.question))
                .slice()
                .sort((left, right) => (left.order || 0) - (right.order || 0));
        }

        baseFilename() {
            const session = this.store.load();
            const settings = this.settingsStore.load();
            const title = safeFileName(session?.paperTitle || '超星题目');
            return settings.includeTimestamp ? `${title}_${timestampText()}` : title;
        }

        exportExcel() {
            const items = this.getItems();
            if (!items.length) throw new Error('没有可导出的题目');
            if (typeof XLSX === 'undefined') throw new Error('Excel 组件尚未加载，请检查网络后刷新页面');

            const rows = items.map(item => ({
                '序号': item.order || '',
                '题型': item.type || '未分类',
                '题目': item.question,
                '选项': (item.options || []).join('\n'),
                '正确答案': item.answer || '',
                '采集状态': normalizeText(item.answer) ? '已获取答案' : '暂无答案',
                '备注': item.missingAnswerReason || '',
                '图片链接': (item.images || []).join('\n'),
            }));

            const worksheet = XLSX.utils.json_to_sheet(rows);
            worksheet['!cols'] = [
                { wch: 8 },
                { wch: 14 },
                { wch: 60 },
                { wch: 45 },
                { wch: 22 },
                { wch: 14 },
                { wch: 30 },
                { wch: 45 },
            ];
            worksheet['!rows'] = rows.map(() => ({ hpt: 42 }));

            const workbook = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(workbook, worksheet, '题目与答案');
            XLSX.writeFile(workbook, `${this.baseFilename()}.xlsx`);
        }

        exportJson() {
            const session = this.store.load();
            const items = this.getItems();
            if (!items.length) throw new Error('没有可导出的题目');
            const answered = items.filter(item => normalizeText(item.answer)).length;
            const payload = {
                title: session?.paperTitle || '超星题目',
                exportedAt: new Date().toISOString(),
                total: session?.total || items.length,
                collected: items.length,
                answered,
                unanswered: items.length - answered,
                questions: items,
            };
            downloadBlob(JSON.stringify(payload, null, 2), `${this.baseFilename()}.json`, 'application/json;charset=utf-8');
        }

        exportMarkdown() {
            const session = this.store.load();
            const items = this.getItems();
            if (!items.length) throw new Error('没有可导出的题目');

            const lines = [`# ${session?.paperTitle || '超星题目'}`, ''];
            items.forEach(item => {
                lines.push(`## ${item.order || ''}. ${item.question}`.replace(/^## \./, '##'));
                if (item.type) lines.push(`- 题型：${item.type}`);
                if (item.options?.length) {
                    lines.push('', ...item.options.map(option => `- ${option}`));
                }
                const answerText = normalizeText(item.answer) || '未获取';
                lines.push('', `**正确答案：${answerText}**`);
                if (!normalizeText(item.answer) && item.missingAnswerReason) {
                    lines.push(`- 备注：${item.missingAnswerReason}`);
                }
                lines.push('');
                if (item.images?.length) {
                    lines.push(...item.images.map(url => `- 图片：${url}`), '');
                }
            });
            downloadBlob(lines.join('\n'), `${this.baseFilename()}.md`, 'text/markdown;charset=utf-8');
        }
    }

    class AIClient {
        constructor(settingsStore) {
            this.settingsStore = settingsStore;
        }

        getSettings() {
            return this.settingsStore.load();
        }

        buildPrompt({ type, question, options }) {
            const optionsText = options?.length
                ? options.map((opt, i) => {
                    const content = normalizeText(opt).replace(/^[A-H\uFF21-\uFF28]\s*[.\u3001\uFF0E:\uFF1A)\uFF09]\s*/, '');
                    return `  ${String.fromCharCode(65 + i)}. ${content}`;
                }).join('\n')
                : '（无选项）';

            let typeInstruction = '';
            const cleanType = normalizeText(type || '');
            if (/单选/.test(cleanType)) {
                typeInstruction = '这是单选题，只返回唯一正确选项字母，例如：A';
            } else if (/多选/.test(cleanType)) {
                typeInstruction = '这是多选题，只返回所有正确选项字母，用英文逗号分隔，例如：A,C';
            } else if (/判断/.test(cleanType)) {
                typeInstruction = '这是判断题，只返回“对”或“错”。';
            } else if (/填空/.test(cleanType)) {
                typeInstruction = '这是填空题，只返回答案；多个空用 | 分隔。';
            } else if (/简答|论述|问答|名词解释|解释题|材料分析|案例分析|翻译|写作|计算题/.test(cleanType)) {
                typeInstruction = '这是简答题，只返回简明、准确的答案正文。';
            } else {
                typeInstruction = '请判断题型并只返回答案本身：单选返回一个字母，多选返回逗号分隔字母，判断返回“对”或“错”，填空多空用 | 分隔。';
            }

            return `${typeInstruction}
不要解释，不要复述题目，不要使用 Markdown，不要输出 JSON。

题目：${question}

选项：
${optionsText}`;
        }

        resolveProviderSettings() {
            const settings = this.getSettings();
            let apiBase = normalizeText(settings.aiApiBase || 'https://api.deepseek.com');
            const apiKey = normalizeText(settings.aiApiKey || '');
            let model = normalizeText(settings.aiModel || 'deepseek-v4-flash');
            const aiThinkingEnabled = Boolean(settings.aiThinkingEnabled);

            if (!apiKey) throw new Error('未配置 AI API Key，请在设置中填写');
            if (!/^https?:\/\//i.test(apiBase)) throw new Error('AI API 地址格式不正确');

            let isOfficialDeepSeek = false;
            try {
                const parsed = new URL(apiBase);
                isOfficialDeepSeek = parsed.hostname.toLowerCase() === 'api.deepseek.com';
            } catch {
                throw new Error('AI API 地址格式不正确');
            }

            if (isOfficialDeepSeek) {
                apiBase = apiBase.replace(/\/v1\/?$/i, '');
                if (model === 'deepseek-chat') model = 'deepseek-v4-flash';
                if (model === 'deepseek-reasoner') model = 'deepseek-v4-pro';
            }

            const normalizedBase = apiBase.replace(/\/+$/, '');
            const url = /\/chat\/completions$/i.test(normalizedBase)
                ? normalizedBase
                : `${normalizedBase}/chat/completions`;

            return { apiKey, model, url, isOfficialDeepSeek, aiThinkingEnabled };
        }

        normalizeMessageContent(value) {
            if (typeof value === 'string') return value;
            if (Array.isArray(value)) {
                return value.map(part => {
                    if (typeof part === 'string') return part;
                    return part?.text ?? part?.content ?? part?.value ?? '';
                }).join('');
            }
            if (value && typeof value === 'object') {
                return String(value.text ?? value.content ?? value.value ?? value.answer ?? '');
            }
            return '';
        }

        async chat(messages, { jsonMode = false, retryWithoutJson = true } = {}) {
            const provider = this.resolveProviderSettings();
            const payload = {
                model: provider.model,
                messages,
                temperature: 0.1,
                max_tokens: 2048,
            };

            // DeepSeek V4 支持 thinking 参数。默认关闭，保证答题速度和最终答案稳定；
            // 在设置中打开后，会请求模型进入思考模式，但仍要求最终只输出答案。
            if (provider.isOfficialDeepSeek && /^deepseek-v4-/i.test(provider.model)) {
                payload.thinking = { type: provider.aiThinkingEnabled ? 'enabled' : 'disabled' };
                if (provider.aiThinkingEnabled) {
                    payload.max_tokens = Math.max(payload.max_tokens, 4096);
                }
            }
            if (jsonMode) payload.response_format = { type: 'json_object' };

            const describeHttpError = (status, statusText, bodyText = '') => {
                let detail = '';
                try {
                    const parsed = JSON.parse(bodyText || '{}');
                    detail = normalizeText(parsed?.error?.message || parsed?.message || '');
                } catch { /* ignore */ }
                const statusHints = {
                    400: '请求参数或模型配置不正确',
                    401: 'API Key 无效或未授权',
                    402: 'API 账户余额不足',
                    403: '请求被服务端拒绝',
                    404: 'API 地址或模型名称不存在',
                    429: '请求过于频繁，请调大填充间隔',
                    500: 'AI 服务内部错误',
                    503: 'AI 服务暂时繁忙',
                };
                const hint = detail || statusHints[status] || statusText || '未知错误';
                return `API 请求失败（${status || '网络错误'}）：${hint}`;
            };

            const readContent = data => {
                if (data?.error) throw new Error(data.error.message || `API 错误：${JSON.stringify(data.error)}`);
                const choice = data?.choices?.[0];
                const message = choice?.message || {};
                const content = this.normalizeMessageContent(message.content ?? choice?.text).trim();
                if (content) return content;

                // 兼容思考模型或部分 OpenAI 兼容接口：最终 content 为空时，使用其返回的
                // reasoning_content 作为解析兜底，不在界面展示完整思考文本。
                const reasoning = this.normalizeMessageContent(message.reasoning_content).trim();
                if (reasoning) return reasoning;

                const finishReason = normalizeText(choice?.finish_reason || '');
                console.warn('[CXAE] API 返回空内容', {
                    model: data?.model || provider.model,
                    finishReason,
                    usage: data?.usage || null,
                });
                if (finishReason === 'length') {
                    throw new Error('AI 输出达到长度上限但没有最终答案，请重试');
                }
                if (finishReason === 'content_filter') {
                    throw new Error('AI 回复被内容过滤，未返回答案');
                }
                if (finishReason === 'insufficient_system_resource') {
                    throw new Error('AI 服务资源不足，请稍后重试');
                }
                throw new Error(`API 返回空内容（模型：${data?.model || provider.model}${finishReason ? `，结束原因：${finishReason}` : ''}）`);
            };

            const requestOnce = requestPayload => new Promise((resolve, reject) => {
                if (typeof GM_xmlhttpRequest === 'undefined') {
                    fetch(provider.url, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${provider.apiKey}`,
                        },
                        body: JSON.stringify(requestPayload),
                    })
                    .then(async response => {
                        const text = await response.text();
                        if (!response.ok) throw new Error(describeHttpError(response.status, response.statusText, text));
                        try {
                            return JSON.parse(text);
                        } catch {
                            throw new Error(`API 响应不是有效 JSON：${text.slice(0, 160)}`);
                        }
                    })
                    .then(data => resolve(readContent(data)))
                    .catch(reject);
                    return;
                }

                GM_xmlhttpRequest({
                    method: 'POST',
                    url: provider.url,
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${provider.apiKey}`,
                    },
                    data: JSON.stringify(requestPayload),
                    onload(response) {
                        const status = Number(response.status) || 0;
                        if (status < 200 || status >= 300) {
                            reject(new Error(describeHttpError(status, response.statusText, response.responseText)));
                            return;
                        }
                        try {
                            const data = JSON.parse(response.responseText);
                            resolve(readContent(data));
                        } catch (error) {
                            reject(error instanceof Error
                                ? error
                                : new Error(`API 响应解析失败：${response.responseText?.slice(0, 160)}`));
                        }
                    },
                    onerror() {
                        reject(new Error('API 网络请求失败，请检查 API 地址、代理和网络连接'));
                    },
                    ontimeout() {
                        reject(new Error('API 请求超时，请稍后重试或调大答题间隔'));
                    },
                    timeout: 45000,
                });
            });

            try {
                return await requestOnce(payload);
            } catch (error) {
                // DeepSeek 官方说明 JSON Output 偶尔会返回空 content。遇到这种情况自动去掉
                // response_format 重试一次，避免整道题直接失败。
                if (jsonMode && retryWithoutJson && /空内容|有效答案|长度上限/i.test(error?.message || '')) {
                    const fallbackPayload = { ...payload };
                    delete fallbackPayload.response_format;
                    return requestOnce(fallbackPayload);
                }
                throw error;
            }
        }

        parseAIResponse(content, expectedType = '') {
            if (!content) return { answer: '', confidence: 0 };
            const text = String(content)
                .replace(/^\s*```(?:json|text)?\s*/i, '')
                .replace(/\s*```\s*$/i, '')
                .trim();
            if (!text) return { answer: '', confidence: 0 };

            const cleanType = normalizeText(expectedType || '');
            const normalizeAnswer = value => {
                if (Array.isArray(value)) {
                    const separator = /填空/.test(cleanType) ? '|' : ',';
                    return value.map(normalizeText).filter(Boolean).join(separator);
                }
                if (value && typeof value === 'object') {
                    const nested = value.answer ?? value.answers ?? value.value ?? value.content ?? '';
                    return normalizeAnswer(nested);
                }
                return normalizeText(value ?? '');
            };

            const candidates = [text];
            const firstBrace = text.indexOf('{');
            const lastBrace = text.lastIndexOf('}');
            if (firstBrace >= 0 && lastBrace > firstBrace) {
                candidates.push(text.slice(firstBrace, lastBrace + 1));
            }

            for (const candidate of candidates) {
                try {
                    const parsed = JSON.parse(candidate);
                    const answer = normalizeAnswer(
                        Array.isArray(parsed) ? parsed : (parsed?.answer ?? parsed?.answers ?? parsed?.result ?? parsed?.response)
                    );
                    if (answer) {
                        return {
                            answer,
                            confidence: Math.max(0, Math.min(1, Number(parsed?.confidence) || 0)),
                        };
                    }
                } catch { /* 尝试后续回退 */ }
            }

            const answerField = text.match(/["']?(?:answer|答案)["']?\s*[:：]\s*["']?([^"'\n}]+)["']?/i);
            if (answerField?.[1]) {
                return { answer: normalizeText(answerField[1]), confidence: 0.5 };
            }

            const lines = text.split('\n').map(normalizeText).filter(Boolean);
            // 优先从末尾寻找最终答案，兼容带有少量解释或 reasoning_content 的接口。
            for (const line of lines.slice().reverse()) {
                const cleaned = line
                    .replace(/^[-*#>\s]+/, '')
                    .replace(/^(?:最终答案|正确答案|答案|answer)\s*[:：]\s*/i, '')
                    .replace(/^(?:选项)\s*/i, '')
                    .replace(/^(?:["'])|(?:["'])$/g, '')
                    .replace(/[。.!！]+$/, '')
                    .trim();

                if (/^[A-HＡ-Ｈ](?:\s*[,，、\s]\s*[A-HＡ-Ｈ])*$/.test(cleaned) || /^[A-HＡ-Ｈ]{1,8}$/.test(cleaned)) {
                    const answer = cleaned
                        .replace(/[Ａ-Ｈ]/g, character => String.fromCharCode(character.charCodeAt(0) - 0xFEE0))
                        .replace(/[，、\s]+/g, ',');
                    return { answer, confidence: 0.5 };
                }
                if (/^(对|错|正确|错误|是|否)$/.test(cleaned)) {
                    return { answer: cleaned, confidence: 0.5 };
                }
            }

            if (/单选/.test(cleanType)) {
                const match = text.match(/(?:最终答案|正确答案|答案|answer|选项)?\s*[:：为是]?\s*\b([A-H])\b(?!\s*[,，、]\s*[A-H])/i);
                if (match?.[1]) return { answer: match[1].toUpperCase(), confidence: 0.4 };
            }
            if (/多选/.test(cleanType)) {
                const match = text.match(/(?:最终答案|正确答案|答案|answer|选项)?\s*[:：为是]?\s*([A-H](?:\s*[,，、\s]\s*[A-H])+)/i);
                if (match?.[1]) {
                    return { answer: match[1].replace(/[，、\s]+/g, ',').toUpperCase(), confidence: 0.4 };
                }
            }
            if (/判断/.test(cleanType)) {
                const matches = Array.from(text.matchAll(/(?:^|[：:\s])(对|错|正确|错误)(?=$|[。.!！\s])/g));
                if (matches.length) return { answer: matches[matches.length - 1][1], confidence: 0.4 };
            }

            // 简答、填空等文本题保留模型正文；选择题不把解释性长文本误当答案。
            if (!/单选|多选|判断/.test(cleanType) && text.length <= 2000) {
                return { answer: text, confidence: 0.3 };
            }
            return { answer: '', confidence: 0 };
        }

        async answerQuestion({ type, question, options }) {
            const prompt = this.buildPrompt({ type, question, options });
            const messages = [
                { role: 'system', content: '你是考试答题助手。只输出最终答案本身，不要解释，不要 Markdown，不要 JSON。' },
                { role: 'user', content: prompt },
            ];

            let content = await this.chat(messages, { jsonMode: false });
            let result = this.parseAIResponse(content, type);
            if (normalizeText(result.answer)) return result;

            // 第一次回复为空白或不可解析时，用更短的提示再试一次。
            const retryMessages = [
                { role: 'system', content: '只返回答案，不要解释。' },
                { role: 'user', content: `${prompt}\n\n再次强调：只输出最终答案。` },
            ];
            content = await this.chat(retryMessages, { jsonMode: false });
            result = this.parseAIResponse(content, type);
            return result;
        }

        async testConnection() {
            const settings = this.getSettings();
            if (!normalizeText(settings.aiApiKey)) throw new Error('未配置 API Key');

            const messages = [
                { role: 'user', content: '请只回复：连接成功' },
            ];
            const content = await this.chat(messages, { jsonMode: false });
            return Boolean(normalizeText(content));
        }
    }

    class AutoFiller {
        constructor(adapter, store, ui, aiClient, settingsStore) {
            this.adapter = adapter;
            this.store = store;
            this.ui = ui;
            this.aiClient = aiClient;
            this.settingsStore = settingsStore;
            this.busy = false;
            this.resumeTimer = null;
        }

        get taskKey() {
            return `${APP.aiTaskPrefix}${simpleHash(this.adapter.getScope())}`;
        }

        report(message, tone = 'normal') {
            this.ui.setStatus(message, tone);
            this.ui.setAiStatus(message, tone);
        }

        loadTask() {
            try {
                const raw = localStorage.getItem(this.taskKey);
                if (!raw) return null;
                const task = JSON.parse(raw);
                if (!task || task.version !== 1) return null;
                task.processedOrders = Array.isArray(task.processedOrders) ? task.processedOrders : [];
                task.success = Number(task.success) || 0;
                task.failed = Number(task.failed) || 0;
                task.skipped = Number(task.skipped) || 0;
                return task;
            } catch (error) {
                console.warn('[CXAE] 读取 AI 自动翻页进度失败。', error);
                return null;
            }
        }

        saveTask(task) {
            if (!task) return false;
            task.version = 1;
            task.scope = this.adapter.getScope();
            task.updatedAt = Date.now();
            try {
                localStorage.setItem(this.taskKey, JSON.stringify(task));
                return true;
            } catch (error) {
                console.error('[CXAE] 保存 AI 自动翻页进度失败。', error);
                return false;
            }
        }

        clearTask() {
            localStorage.removeItem(this.taskKey);
        }

        createPagedTask(total) {
            return {
                version: 1,
                scope: this.adapter.getScope(),
                active: true,
                phase: 'starting',
                total: Number(total) || 0,
                nextOrder: 1,
                targetOrder: 1,
                processedOrders: [],
                success: 0,
                failed: 0,
                skipped: 0,
                lastError: '',
                createdAt: Date.now(),
                updatedAt: Date.now(),
            };
        }

        firstPendingOrder(task) {
            const processed = new Set((task?.processedOrders || []).map(Number));
            const total = Number(task?.total) || 0;
            for (let order = 1; order <= total; order += 1) {
                if (!processed.has(order)) return order;
            }
            return total + 1;
        }

        markTaskProcessed(task, order) {
            const value = Number(order);
            if (value > 0) {
                task.processedOrders = Array.from(new Set([...(task.processedOrders || []), value]))
                    .sort((left, right) => left - right);
            }
            task.nextOrder = this.firstPendingOrder(task);
        }

        getPagedInfo() {
            const navigationNumbers = this.adapter.getQuestionNavigationNumbers();
            const visibleTargets = this.adapter.getVisibleAnswerTargets();
            const detectedTotal = this.adapter.detectTotal();
            const navigationTotal = navigationNumbers.length ? Math.max(...navigationNumbers) : 0;
            const total = Math.max(detectedTotal, navigationTotal);
            const hasDirectionalNavigation = Boolean(
                this.adapter.findNavigation('下一题') || this.adapter.findNavigation('上一题')
            );
            const paged = total > 1 && visibleTargets.length <= 1 &&
                (navigationNumbers.length >= 2 || hasDirectionalNavigation);
            return { paged, total, navigationNumbers, visibleTargets };
        }

        matchQuestionNode(item, nodes, used = new Set()) {
            return this.adapter.findQuestionNodeForItem(item, nodes, used);
        }

        async aiAutoFill() {
            if (this.busy) {
                this.report('AI 答题正在进行中', 'active');
                return;
            }

            const settings = this.settingsStore.load();
            if (!normalizeText(settings.aiApiKey)) {
                this.report('请先在设置中填写 AI API Key，并点击“测试连接”', 'error');
                return;
            }

            const existingTask = this.loadTask();
            if (existingTask?.active && this.firstPendingOrder(existingTask) <= Number(existingTask.total)) {
                this.report(`继续 AI 自动翻页：第 ${this.firstPendingOrder(existingTask)} / ${existingTask.total} 题`, 'active');
                await this.runPagedTask();
                return;
            }

            const pageInfo = this.getPagedInfo();
            if (pageInfo.paged) {
                let task = existingTask;
                if (!task || task.phase === 'completed' || Number(task.total) !== Number(pageInfo.total)) {
                    task = this.createPagedTask(pageInfo.total);
                } else {
                    task.active = true;
                    task.phase = 'resuming';
                    task.total = Math.max(Number(task.total) || 0, pageInfo.total);
                    task.nextOrder = this.firstPendingOrder(task);
                }
                this.saveTask(task);
                await this.runPagedTask();
                return;
            }

            const targets = this.adapter.getAnswerTargets();
            if (!targets.length) {
                const vueCount = this.adapter.getVuePracticeItems().length;
                this.report(
                    vueCount
                        ? `已读取 ${vueCount} 道题，但没有找到页面上的可作答控件；请展开全部题目后重试`
                        : '当前页面没有识别到可作答题目；请进入作答页并等待题目加载完成',
                    'error'
                );
                return;
            }

            await this.runInlineTargets(targets);
        }

        async runInlineTargets(targets) {
            this.busy = true;
            let success = 0;
            let failed = 0;
            let skipped = 0;
            let lastError = '';
            const settings = this.settingsStore.load();

            try {
                this.report(`AI 答题开始：共识别 ${targets.length} 题`, 'active');

                for (let index = 0; index < targets.length; index += 1) {
                    if (!this.busy) break;
                    const { node, item } = targets[index];
                    if (!node || !item?.question) {
                        skipped += 1;
                        continue;
                    }

                    this.report(
                        `AI 答题中：${index + 1} / ${targets.length} — ${item.question.slice(0, 30)}${item.question.length > 30 ? '…' : ''}`,
                        'active'
                    );

                    try {
                        const liveItem = this.adapter.parseQuestion(node, Number(item.order) || index + 1) || item;
                        const result = await this.aiClient.answerQuestion({
                            type: liveItem.type || item.type,
                            question: liveItem.question || item.question,
                            options: liveItem.options?.length ? liveItem.options : item.options,
                        });

                        if (!normalizeText(result.answer)) {
                            failed += 1;
                            lastError = 'AI 未返回可识别答案';
                            console.warn(`[CXAE] AI答题 第${index + 1}题 未获取到答案`);
                        } else if (this.adapter.fillQuestion(node, result.answer, item.type)) {
                            success += 1;
                            this.recordGeneratedAnswer(item, result, Number(item.order) || index + 1, targets.length);
                            console.log(
                                `[CXAE] AI答题 第${index + 1}题 成功：${result.answer}（置信度 ${result.confidence}）`
                            );
                        } else {
                            failed += 1;
                            lastError = `答案“${result.answer}”未能匹配页面控件${this.adapter.lastFillError ? `（${this.adapter.lastFillError}）` : ''}`;
                            console.warn(
                                `[CXAE] AI答题 第${index + 1}题 填充失败：答案=${result.answer}，题型=${item.type}`
                            );
                        }
                    } catch (error) {
                        failed += 1;
                        lastError = error?.message || String(error);
                        console.error(`[CXAE] AI答题 第${index + 1}题 出错：`, error);
                    }

                    const delay = Math.max(200, Number(settings.autoFillDelay) || 500);
                    if (index < targets.length - 1 && this.busy) await sleep(delay);
                }

                if (!this.busy) {
                    this.report(`AI 答题已停止：成功 ${success} 题，失败 ${failed} 题，跳过 ${skipped} 题`, 'normal');
                    return;
                }

                const summary = `AI 答题完成：成功 ${success} 题，失败 ${failed} 题，跳过 ${skipped} 题` +
                    (lastError ? `；最后错误：${lastError}` : '');
                this.report(summary, success > 0 ? 'success' : 'error');
                this.ui.refresh();
            } catch (error) {
                this.report(`AI 答题异常：${error.message || '未知错误'}`, 'error');
            } finally {
                this.busy = false;
            }
        }

        async ensurePagedQuestion(order, task) {
            const targetOrder = Number(order);
            const currentOrder = this.adapter.getCurrentOrder();
            if (currentOrder === targetOrder) return true;

            const previousSignature = this.adapter.getQuestionSignature();
            let navigation = this.adapter.findNumberButton(targetOrder);
            if (!navigation && currentOrder > 0) {
                if (targetOrder === currentOrder + 1) navigation = this.adapter.findNavigation('下一题');
                else if (targetOrder === currentOrder - 1) navigation = this.adapter.findNavigation('上一题');
            }
            if (!navigation) {
                task.lastError = `找不到第 ${targetOrder} 题的题号按钮或翻页按钮`;
                this.saveTask(task);
                return false;
            }

            task.phase = 'navigating';
            task.targetOrder = targetOrder;
            this.saveTask(task);

            try {
                navigation.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
                navigation.click();
            } catch (error) {
                const href = navigation.href || navigation.getAttribute?.('href');
                if (href && !/^javascript:/i.test(href)) {
                    location.assign(href);
                    return false;
                }
                task.lastError = `点击第 ${targetOrder} 题失败：${error?.message || error}`;
                this.saveTask(task);
                return false;
            }

            const switched = await this.adapter.waitForQuestionSwitch(
                previousSignature,
                targetOrder,
                APP.aiNavigationTimeout
            );
            if (switched) return true;

            const latestOrder = this.adapter.getCurrentOrder();
            const latestSignature = this.adapter.getQuestionSignature();
            return latestOrder === targetOrder || Boolean(latestSignature && latestSignature !== previousSignature);
        }

        async waitForCurrentTarget(order, timeout = APP.questionWaitTimeout) {
            const startedAt = Date.now();
            while (Date.now() - startedAt < timeout) {
                const target = this.adapter.getCurrentAnswerTarget();
                if (target?.node && target?.item?.question) return target;
                await sleep(220);
            }
            return null;
        }

        recordGeneratedAnswer(item, result, order, total = 0) {
            try {
                let session = this.store.load() || this.store.create('ai-paged');
                const wasActive = Boolean(session.active);
                const previousPhase = session.phase;
                session.mode = session.mode === 'practice-vue' || session.mode === 'long-page'
                    ? session.mode
                    : 'ai-paged';
                session.total = Math.max(Number(session.total) || 0, Number(total) || 0, Number(order) || 0);
                this.store.addItem(session, {
                    ...item,
                    order: Number(order) || Number(item.order) || 0,
                    answer: normalizeText(result.answer),
                    source: 'ai-generated',
                    confidence: Number(result.confidence) || 0,
                    sourceUrl: location.href,
                });
                session.active = wasActive;
                session.phase = wasActive ? previousPhase : 'paused';
                session.message = wasActive ? session.message : 'AI 自动答题已生成并回填答案';
                this.store.save(session);
            } catch (error) {
                console.warn('[CXAE] 保存 AI 生成答案失败。', error);
            }
        }

        async runPagedTask() {
            if (this.busy) return;
            let task = this.loadTask();
            if (!task?.active) return;

            this.busy = true;
            try {
                while (this.busy) {
                    task = this.loadTask() || task;
                    if (!task.active) break;

                    const order = this.firstPendingOrder(task);
                    if (order > Number(task.total)) {
                        task.active = false;
                        task.phase = 'completed';
                        task.nextOrder = order;
                        this.saveTask(task);
                        const summary = `AI 自动翻页完成：成功 ${task.success} 题，失败 ${task.failed} 题，跳过 ${task.skipped} 题` +
                            (task.lastError ? `；最后错误：${task.lastError}` : '');
                        this.report(summary, task.success > 0 ? 'success' : 'error');
                        this.ui.refresh();
                        return;
                    }

                    task.nextOrder = order;
                    task.targetOrder = order;
                    task.phase = 'positioning';
                    this.saveTask(task);
                    this.report(
                        `AI 自动翻页：第 ${order} / ${task.total} 题（成功 ${task.success}，失败 ${task.failed}）`,
                        'active'
                    );

                    const positioned = await this.ensurePagedQuestion(order, task);
                    if (!this.busy) break;
                    if (!positioned) {
                        task = this.loadTask() || task;
                        task.active = false;
                        task.phase = 'paused';
                        task.lastError ||= `无法切换到第 ${order} 题`;
                        this.saveTask(task);
                        this.report(`AI 自动翻页已暂停：${task.lastError}`, 'error');
                        return;
                    }

                    const target = await this.waitForCurrentTarget(order);
                    if (!this.busy) break;
                    if (!target?.node || !target?.item?.question) {
                        task = this.loadTask() || task;
                        task.skipped += 1;
                        task.lastError = `第 ${order} 题页面加载后未识别到题目或作答控件`;
                        this.markTaskProcessed(task, order);
                        this.saveTask(task);
                        continue;
                    }

                    const item = { ...target.item, order };
                    try {
                        const liveItem = this.adapter.parseQuestion(target.node, order) || item;
                        const result = await this.aiClient.answerQuestion({
                            type: liveItem.type || item.type,
                            question: liveItem.question || item.question,
                            options: liveItem.options?.length ? liveItem.options : item.options,
                        });
                        if (!normalizeText(result.answer)) {
                            task.failed += 1;
                            task.lastError = `第 ${order} 题：AI 未返回可识别答案`;
                            console.warn(`[CXAE] AI自动翻页 第${order}题 未获取到答案`);
                        } else if (this.adapter.fillQuestion(target.node, result.answer, item.type)) {
                            task.success += 1;
                            task.lastError = '';
                            this.recordGeneratedAnswer(item, result, order, task.total);
                            console.log(
                                `[CXAE] AI自动翻页 第${order}题 成功：${result.answer}（置信度 ${result.confidence}）`
                            );
                        } else {
                            task.failed += 1;
                            task.lastError = `第 ${order} 题：答案“${result.answer}”未能匹配页面控件${this.adapter.lastFillError ? `（${this.adapter.lastFillError}）` : ''}`;
                            console.warn(
                                `[CXAE] AI自动翻页 第${order}题 填充失败：答案=${result.answer}，题型=${item.type}`
                            );
                        }
                    } catch (error) {
                        task.failed += 1;
                        task.lastError = `第 ${order} 题：${error?.message || String(error)}`;
                        console.error(`[CXAE] AI自动翻页 第${order}题 出错：`, error);
                    }

                    this.markTaskProcessed(task, order);
                    task.phase = 'answered';
                    this.saveTask(task);
                    this.ui.refresh();

                    const settings = this.settingsStore.load();
                    const delay = Math.max(300, Number(settings.autoFillDelay) || 500);
                    if (this.firstPendingOrder(task) <= Number(task.total) && this.busy) await sleep(delay);
                }

                task = this.loadTask() || task;
                if (!this.busy || !task.active) {
                    const summary = `AI 自动翻页已停止：成功 ${task.success} 题，失败 ${task.failed} 题，跳过 ${task.skipped} 题`;
                    this.report(summary, 'normal');
                }
            } catch (error) {
                task = this.loadTask() || task;
                task.active = false;
                task.phase = 'error';
                task.lastError = error?.message || String(error);
                this.saveTask(task);
                this.report(`AI 自动翻页异常：${task.lastError}`, 'error');
            } finally {
                this.busy = false;
            }
        }

        async fillFromCollected() {
            if (this.busy) {
                this.report('答题任务正在进行中', 'active');
                return;
            }

            const session = this.store.load();
            const items = (session?.items || []).filter(item => normalizeText(item.answer));
            if (!items.length) {
                this.report('没有已采集的正确答案可回填', 'error');
                return;
            }

            const nodes = this.adapter.getQuestionNodes();
            if (!nodes.length) {
                this.report('当前页面没有识别到可作答题目', 'error');
                return;
            }

            this.busy = true;
            let success = 0;
            let failed = 0;
            let skipped = 0;
            const used = new Set();

            try {
                this.report(`回填答案开始：${items.length} 个答案待回填`, 'active');
                const settings = this.settingsStore.load();
                const delay = Math.max(0, Math.min(1000, Number(settings.autoFillDelay) || 500));

                for (let index = 0; index < items.length; index += 1) {
                    if (!this.busy) break;
                    const item = items[index];
                    const node = this.matchQuestionNode(item, nodes, used);
                    if (!node) {
                        skipped += 1;
                        continue;
                    }
                    used.add(node);

                    if (this.adapter.fillQuestion(node, item.answer, item.type)) success += 1;
                    else failed += 1;

                    if ((index + 1) % 5 === 0) {
                        this.report(`回填中：${index + 1} / ${items.length}`, 'active');
                    }
                    if (delay > 0 && index < items.length - 1) await sleep(delay);
                }

                const summary = `回填完成：成功 ${success} 题，失败 ${failed} 题，跳过 ${skipped} 题`;
                this.report(summary, success > 0 ? 'success' : 'error');
            } catch (error) {
                this.report(`回填异常：${error.message || '未知错误'}`, 'error');
            } finally {
                this.busy = false;
            }
        }

        stop() {
            const task = this.loadTask();
            const wasRunning = this.busy || Boolean(task?.active);
            if (task?.active) {
                task.active = false;
                task.phase = 'stopped';
                this.saveTask(task);
            }
            this.busy = false;
            this.report(wasRunning ? 'AI 答题已停止，进度已保存' : '当前没有正在运行的答题任务', 'normal');
        }

        autoResume() {
            clearTimeout(this.resumeTimer);
            const task = this.loadTask();
            if (task?.active && this.firstPendingOrder(task) <= Number(task.total)) {
                this.resumeTimer = setTimeout(() => {
                    this.report(`正在恢复 AI 自动翻页：第 ${this.firstPendingOrder(task)} / ${task.total} 题`, 'active');
                    this.runPagedTask();
                }, 1200);
            }
        }
    }

    class AppUI {
        constructor(store, settingsStore) {
            this.store = store;
            this.settingsStore = settingsStore;
            this.handlers = {};
            this.host = null;
            this.shadow = null;
            this.opened = false;
            this.logs = [];
        }

        mount() {
            if (document.getElementById(`${APP.id}-host`)) return;
            this.host = document.createElement('div');
            this.host.id = `${APP.id}-host`;
            document.documentElement.appendChild(this.host);
            this.shadow = this.host.attachShadow({ mode: 'open' });

            const style = document.createElement('style');
            style.textContent = `
                :host { all: initial; }
                * { box-sizing: border-box; }
                button, input { font: inherit; }
                .launcher {
                    position: fixed; right: 20px; bottom: 20px; z-index: 2147483646;
                    width: 54px; height: 54px; border: 0; border-radius: 16px;
                    display: grid; place-items: center; cursor: pointer;
                    color: #fff; background: #2563eb;
                    box-shadow: 0 12px 30px rgba(37, 99, 235, .32);
                    transition: transform .16s ease, box-shadow .16s ease;
                }
                .launcher:hover { transform: translateY(-2px); box-shadow: 0 16px 36px rgba(37, 99, 235, .38); }
                .launcher svg { width: 27px; height: 27px; }
                .panel {
                    position: fixed; right: 20px; bottom: 86px; z-index: 2147483647;
                    width: 380px; max-width: calc(100vw - 24px); max-height: min(680px, calc(100vh - 110px));
                    overflow: hidden; display: none; flex-direction: column;
                    color: #0f172a; background: rgba(255,255,255,.98);
                    border: 1px solid #e2e8f0; border-radius: 18px;
                    box-shadow: 0 24px 72px rgba(15,23,42,.22);
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
                    font-size: 14px;
                }
                .panel.open { display: flex; }
                .header { padding: 16px 16px 13px; border-bottom: 1px solid #e2e8f0; display: flex; align-items: center; gap: 10px; }
                .logo { width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center; color: #fff; background: #2563eb; font-weight: 800; }
                .heading { min-width: 0; flex: 1; }
                .title { margin: 0; font-size: 16px; line-height: 1.2; font-weight: 750; }
                .subtitle { margin-top: 3px; color: #64748b; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
                .icon-btn { border: 0; background: transparent; color: #64748b; width: 32px; height: 32px; border-radius: 8px; cursor: pointer; font-size: 22px; line-height: 1; }
                .icon-btn:hover { background: #f1f5f9; color: #0f172a; }
                .content { overflow: auto; padding: 14px; }
                .mode-row { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
                .badge { border-radius: 999px; padding: 5px 9px; font-size: 12px; font-weight: 650; background: #eff6ff; color: #1d4ed8; }
                .scope { min-width: 0; flex: 1; color: #64748b; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
                .card { border: 1px solid #e2e8f0; border-radius: 14px; background: #fff; padding: 13px; margin-bottom: 12px; }
                .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
                .stat { min-width: 0; }
                .stat-value { display: block; font-size: 19px; font-weight: 760; color: #0f172a; }
                .stat-label { display: block; margin-top: 2px; color: #64748b; font-size: 11px; }
                .progress { height: 7px; margin-top: 12px; overflow: hidden; border-radius: 999px; background: #e2e8f0; }
                .progress > div { width: 0; height: 100%; border-radius: inherit; background: #2563eb; transition: width .22s ease; }
                .status { margin-top: 10px; color: #475569; font-size: 12px; line-height: 1.5; }
                .status[data-tone="success"] { color: #047857; }
                .status[data-tone="error"] { color: #b91c1c; }
                .status[data-tone="active"] { color: #1d4ed8; }
                .section-title { margin: 0 0 9px; color: #334155; font-size: 12px; font-weight: 760; letter-spacing: .04em; text-transform: uppercase; }
                .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
                .button { border: 1px solid #cbd5e1; border-radius: 10px; min-height: 40px; padding: 9px 11px; cursor: pointer; color: #0f172a; background: #fff; font-weight: 650; }
                .button:hover:not(:disabled) { border-color: #94a3b8; background: #f8fafc; }
                .button.primary { color: #fff; border-color: #2563eb; background: #2563eb; }
                .button.primary:hover:not(:disabled) { background: #1d4ed8; }
                .button.danger { color: #b91c1c; }
                .button:disabled { opacity: .45; cursor: not-allowed; }
                .full { grid-column: 1 / -1; }
                .settings { display: grid; gap: 9px; }
                .setting { display: flex; align-items: center; justify-content: space-between; gap: 10px; color: #334155; }
                .switch { position: relative; width: 40px; height: 22px; flex: none; }
                .switch input { position: absolute; opacity: 0; }
                .switch span { position: absolute; inset: 0; border-radius: 999px; cursor: pointer; background: #cbd5e1; transition: .16s; }
                .switch span::after { content: ""; position: absolute; width: 16px; height: 16px; top: 3px; left: 3px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.2); transition: .16s; }
                .switch input:checked + span { background: #2563eb; }
                .switch input:checked + span::after { transform: translateX(18px); }
                .skipped { display: none; margin-top: 10px; padding-top: 10px; border-top: 1px dashed #cbd5e1; }
                .skipped.visible { display: block; }
                .skipped-item { margin-top: 5px; color: #64748b; font-size: 11px; line-height: 1.45; }
                .footer { color: #94a3b8; text-align: center; font-size: 11px; padding: 1px 0 3px; }
                .input-field { width: 100%; border: 1px solid #cbd5e1; border-radius: 8px; padding: 7px 10px; font-size: 13px; color: #0f172a; background: #fff; outline: none; transition: border-color .15s; }
                .input-field:focus { border-color: #2563eb; }
                .input-field::placeholder { color: #94a3b8; }
                .input-row { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
                .input-row .input-field { flex: 1; }
                .input-label { display: block; margin-bottom: 4px; color: #334155; font-size: 12px; font-weight: 600; }
                .btn-sm { border: 1px solid #cbd5e1; border-radius: 8px; padding: 6px 12px; font-size: 12px; cursor: pointer; color: #0f172a; background: #fff; font-weight: 600; white-space: nowrap; }
                .btn-sm:hover { border-color: #94a3b8; background: #f8fafc; }
                .ai-status { margin-top: 6px; color: #475569; font-size: 11px; line-height: 1.4; }
                .ai-status[data-tone="success"] { color: #047857; }
                .ai-status[data-tone="error"] { color: #b91c1c; }
                .ai-status[data-tone="active"] { color: #1d4ed8; }
                @media (max-width: 520px) {
                    .launcher { right: 12px; bottom: 12px; }
                    .panel { right: 12px; bottom: 76px; width: calc(100vw - 24px); max-height: calc(100vh - 92px); }
                }
                @media (prefers-color-scheme: dark) {
                    .panel { color: #e2e8f0; background: rgba(15,23,42,.98); border-color: #334155; }
                    .header { border-color: #334155; }
                    .subtitle, .scope, .stat-label, .status, .skipped-item { color: #94a3b8; }
                    .icon-btn { color: #94a3b8; }
                    .icon-btn:hover { color: #e2e8f0; background: #1e293b; }
                    .card { background: #111827; border-color: #334155; }
                    .stat-value, .button { color: #e2e8f0; }
                    .section-title, .setting { color: #cbd5e1; }
                    .button { background: #0f172a; border-color: #475569; }
                    .button:hover:not(:disabled) { background: #1e293b; border-color: #64748b; }
                    .button.primary { background: #2563eb; border-color: #2563eb; color: #fff; }
                    .progress { background: #334155; }
                    .skipped { border-color: #475569; }
                    .input-field { color: #e2e8f0; background: #0f172a; border-color: #475569; }
                    .input-field:focus { border-color: #2563eb; }
                    .input-label { color: #cbd5e1; }
                    .btn-sm { color: #e2e8f0; background: #0f172a; border-color: #475569; }
                    .btn-sm:hover { background: #1e293b; border-color: #64748b; }
                    .ai-status { color: #94a3b8; }
                }
            `;

            const wrapper = document.createElement('div');
            wrapper.innerHTML = `
                <button class="launcher" type="button" aria-label="打开${APP.name}" title="打开${APP.name}">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M5 3h11a3 3 0 0 1 3 3v13.5a1.5 1.5 0 0 1-2.28 1.28L12 18l-4.72 2.78A1.5 1.5 0 0 1 5 19.5V3Zm3 4v2h8V7H8Zm0 4v2h8v-2H8Z"/></svg>
                </button>
                <section class="panel" role="dialog" aria-label="${APP.name}">
                    <header class="header">
                        <div class="logo">学</div>
                        <div class="heading">
                            <h2 class="title">${APP.name}</h2>
                            <div class="subtitle" data-role="paper-title">等待识别试卷</div>
                        </div>
                        <button class="icon-btn" type="button" data-action="close" aria-label="关闭">×</button>
                    </header>
                    <main class="content">
                        <div class="mode-row">
                            <span class="badge" data-role="mode">等待题目</span>
                            <span class="scope" data-role="scope">保存全部题目与可用答案</span>
                        </div>

                        <section class="card">
                            <div class="stats">
                                <div class="stat"><span class="stat-value" data-stat="answers">0</span><span class="stat-label">已获答案</span></div>
                                <div class="stat"><span class="stat-value" data-stat="processed">0</span><span class="stat-label">已处理</span></div>
                                <div class="stat"><span class="stat-value" data-stat="skipped">0</span><span class="stat-label">暂无答案</span></div>
                                <div class="stat"><span class="stat-value" data-stat="total">—</span><span class="stat-label">总题数</span></div>
                            </div>
                            <div class="progress"><div data-role="progress-bar"></div></div>
                            <div class="status" data-role="status" data-tone="normal">等待操作</div>
                            <div class="skipped" data-role="skipped-list"></div>
                        </section>

                        <section class="card">
                            <h3 class="section-title">采集</h3>
                            <div class="grid">
                                <button class="button primary full" type="button" data-action="start">开始 / 继续采集</button>
                                <button class="button" type="button" data-action="scan">仅扫描当前页</button>
                                <button class="button" type="button" data-action="pause">暂停并保存</button>
                            </div>
                        </section>

                        <section class="card">
                            <h3 class="section-title">导出</h3>
                            <div class="grid">
                                <button class="button" type="button" data-action="excel">Excel</button>
                                <button class="button" type="button" data-action="markdown">Markdown</button>
                                <button class="button full" type="button" data-action="json">JSON 备份</button>
                            </div>
                        </section>

                        <section class="card">
                            <h3 class="section-title">AI 答题</h3>
                            <div class="grid">
                                <button class="button primary full" type="button" data-action="ai-fill">AI 自动答题（自动翻页）</button>
                                <button class="button" type="button" data-action="fill-collected">回填已采集答案</button>
                                <button class="button" type="button" data-action="stop-fill">停止答题</button>
                            </div>
                            <div class="ai-status" data-role="ai-status">支持当前页和逐题换页；换页试卷会按题号自动作答并保存进度</div>
                        </section>

                        <section class="card">
                            <h3 class="section-title">自动刷课</h3>
                            <div class="settings">
                                <label class="setting"><span>启用自动刷课</span><span class="switch"><input type="checkbox" data-study-setting="enabled"><span></span></span></label>
                                <label class="setting"><span>自动播放视频</span><span class="switch"><input type="checkbox" data-study-setting="autoplay"><span></span></span></label>
                                <label class="setting"><span>AI 做章节测验</span><span class="switch"><input type="checkbox" data-study-setting="solveQuizWithAi"><span></span></span></label>
                                <label class="setting"><span>自动提交测验</span><span class="switch"><input type="checkbox" data-study-setting="autoSubmitQuiz"><span></span></span></label>
                                <label class="setting"><span>找不到视频时跳过</span><span class="switch"><input type="checkbox" data-study-setting="skipQuiz"><span></span></span></label>
                                <label class="setting"><span>倍速</span><input class="input-field" type="number" data-study-setting="playbackRate" min="0.5" max="16" step="0.1" style="width: 96px;"></label>
                            </div>
                            <div class="grid" style="margin-top: 10px;">
                                <button class="button" type="button" data-study-action="start">立即启动</button>
                                <button class="button" type="button" data-study-action="stop">暂停</button>
                            </div>
                            <div class="ai-status" data-role="study-status">自动刷课控制已合并到本面板；关闭“找不到视频时跳过”后会优先尝试 AI 做测验</div>
                        </section>

                        <section class="card">
                            <h3 class="section-title">设置</h3>
                            <div class="settings">
                                <label class="setting"><span>未作答题自动点击"显示答案"</span><span class="switch"><input type="checkbox" data-setting="autoRevealAnswer"><span></span></span></label>
                                <label class="setting"><span>导出文件名添加时间</span><span class="switch"><input type="checkbox" data-setting="includeTimestamp"><span></span></span></label>
                            </div>
                            <div style="margin-top: 12px; padding-top: 10px; border-top: 1px dashed #cbd5e1;">
                                <div style="color: #334155; font-size: 12px; font-weight: 760; margin-bottom: 8px;">AI 配置</div>
                                <div style="margin-bottom: 8px;">
                                    <label class="input-label">API Key</label>
                                    <input class="input-field" type="password" data-setting="aiApiKey" placeholder="输入你的 DeepSeek API Key">
                                </div>
                                <div class="input-row">
                                    <div style="flex: 1;">
                                        <label class="input-label">API 地址</label>
                                        <input class="input-field" type="text" data-setting="aiApiBase" placeholder="https://api.deepseek.com">
                                    </div>
                                </div>
                                <div class="input-row">
                                    <div style="flex: 1;">
                                        <label class="input-label">模型</label>
                                        <input class="input-field" type="text" data-setting="aiModel" placeholder="deepseek-v4-flash">
                                    </div>
                                    <button class="btn-sm" type="button" data-action="test-ai">测试连接</button>
                                </div>
                                <div class="settings" style="margin-top: 8px;">
                                    <label class="setting"><span>DeepSeek V4 打开思考（更慢、更耗额度）</span><span class="switch"><input type="checkbox" data-setting="aiThinkingEnabled"><span></span></span></label>
                                </div>
                                <div style="margin-top: 4px;">
                                    <label class="input-label">填充间隔（毫秒）</label>
                                    <input class="input-field" type="number" data-setting="autoFillDelay" placeholder="500" min="200" max="5000" style="width: 120px;">
                                </div>
                                <div style="margin-top: 8px;">
                                    <label class="input-label">采集翻页间隔（毫秒）</label>
                                    <input class="input-field" type="number" data-setting="collectionDelay" placeholder="120" min="0" max="2000" style="width: 120px;">
                                </div>
                            </div>
                        </section>

                        <section class="card">
                            <button class="button danger full" type="button" data-action="clear">清空当前试卷数据</button>
                        </section>
                        <div class="footer">v${APP.version} · 数据仅保存在当前浏览器</div>
                    </main>
                </section>
            `;

            this.shadow.append(style, wrapper);
            this.bind();
            this.applySettings();
            this.refresh();
        }

        $(selector) {
            return this.shadow?.querySelector(selector) || null;
        }

        bind() {
            this.$('.launcher').addEventListener('click', () => this.toggle());
            this.$('[data-action="close"]').addEventListener('click', () => this.close());
            this.shadow.querySelectorAll('[data-action]').forEach(button => {
                const action = button.dataset.action;
                if (action === 'close') return;
                button.addEventListener('click', () => this.handlers[action]?.());
            });

            this.shadow.querySelectorAll('[data-setting]').forEach(input => {
                const eventType = (input.type === 'text' || input.type === 'password' || input.type === 'number') ? 'change' : 'change';
                input.addEventListener(eventType, () => {
                    const settings = this.settingsStore.load();
                    if (input.type === 'checkbox') {
                        settings[input.dataset.setting] = input.checked;
                    } else if (input.type === 'number') {
                        settings[input.dataset.setting] = Number(input.value) || undefined;
                    } else {
                        settings[input.dataset.setting] = input.value;
                    }
                    this.settingsStore.save(settings);
                    this.handlers.settings?.(settings);
                });
                // 文本输入也监听 blur，确保值保存
                if (input.type === 'text' || input.type === 'password' || input.type === 'number') {
                    input.addEventListener('blur', () => {
                        const settings = this.settingsStore.load();
                        if (input.type === 'number') {
                            settings[input.dataset.setting] = Number(input.value) || undefined;
                        } else {
                            settings[input.dataset.setting] = input.value;
                        }
                        this.settingsStore.save(settings);
                    });
                }
            });
            this.bindStudyControls();
        }

        studyDefaults() {
            return {
                enabled: true,
                playbackRate: 1.5,
                autoplay: true,
                skipQuiz: false,
                solveQuizWithAi: true,
                autoSubmitQuiz: true,
            };
        }

        loadStudySettings() {
            try {
                const parsed = JSON.parse(localStorage.getItem('CX_STUDY_AUTOPLAYER_SETTINGS') || '{}');
                return { ...this.studyDefaults(), ...parsed };
            } catch {
                return { ...this.studyDefaults() };
            }
        }

        saveStudySettings(settings) {
            const merged = { ...this.studyDefaults(), ...(settings || {}) };
            try {
                const existing = JSON.parse(localStorage.getItem('CX_STUDY_AUTOPLAYER_SETTINGS') || '{}');
                localStorage.setItem('CX_STUDY_AUTOPLAYER_SETTINGS', JSON.stringify({ ...existing, ...merged }));
            } catch {
                localStorage.setItem('CX_STUDY_AUTOPLAYER_SETTINGS', JSON.stringify(merged));
            }
            return merged;
        }

        getStudyPlayer() {
            return window.cxStudyAutoPlayer || window['cx-study-autoplayer'] || null;
        }

        bindStudyControls() {
            this.shadow.querySelectorAll('[data-study-setting]').forEach(input => {
                input.addEventListener('change', () => {
                    const key = input.dataset.studySetting;
                    const value = input.type === 'checkbox' ? Boolean(input.checked) : Number(input.value);
                    this.updateStudySettings({ [key]: value });
                });
            });
            this.shadow.querySelectorAll('[data-study-action]').forEach(button => {
                button.addEventListener('click', () => {
                    const action = button.dataset.studyAction;
                    if (action === 'start') {
                        this.updateStudySettings({ enabled: true });
                        const player = this.getStudyPlayer();
                        if (player?.start) {
                            player.start();
                            this.setStudyStatus('自动刷课已启动', 'active');
                        } else {
                            this.setStudyStatus('已保存开启状态；请确认当前是课程学习页', 'active');
                        }
                    } else if (action === 'stop') {
                        this.updateStudySettings({ enabled: false });
                        this.setStudyStatus('自动刷课已暂停', 'normal');
                    }
                });
            });
        }

        updateStudySettings(patch = {}) {
            const settings = this.saveStudySettings({ ...this.loadStudySettings(), ...patch });
            const player = this.getStudyPlayer();
            if (player?._updateSettings) {
                player._updateSettings(patch);
            } else {
                try {
                    window.dispatchEvent(new CustomEvent('cx-study-autoplayer-settings', { detail: settings }));
                } catch {}
            }
            this.applyStudySettings();
            this.setStudyStatus(settings.enabled ? '自动刷课已开启' : '自动刷课已关闭', settings.enabled ? 'active' : 'normal');
        }

        applyStudySettings() {
            const settings = this.loadStudySettings();
            this.shadow?.querySelectorAll('[data-study-setting]').forEach(input => {
                const key = input.dataset.studySetting;
                const value = settings[key];
                if (input.type === 'checkbox') input.checked = Boolean(value);
                else input.value = value ?? '';
            });
            const isStudyPage = /\/mycourse\/studentstudy/i.test(location.href);
            const player = this.getStudyPlayer();
            if (!isStudyPage) {
                this.setStudyStatus('自动刷课只在课程学习页生效；设置会保存在本浏览器', 'normal');
            } else if (player) {
                this.setStudyStatus(settings.enabled ? '自动刷课模块已连接' : '自动刷课模块已关闭', settings.enabled ? 'active' : 'normal');
            } else {
                this.setStudyStatus('等待自动刷课模块加载…', 'normal');
            }
        }

        setStudyStatus(text, tone = 'normal') {
            const node = this.$('[data-role="study-status"]');
            if (!node) return;
            node.textContent = text;
            node.dataset.tone = tone;
        }

        on(action, handler) {
            this.handlers[action] = handler;
        }

        applySettings() {
            const settings = this.settingsStore.load();
            this.shadow.querySelectorAll('[data-setting]').forEach(input => {
                const key = input.dataset.setting;
                const value = settings[key];
                if (input.type === 'checkbox') {
                    input.checked = Boolean(value);
                } else {
                    if (value !== undefined && value !== '') {
                        input.value = value;
                    }
                }
            });
            this.applyStudySettings();
        }

        toggle() {
            this.opened ? this.close() : this.open();
        }

        open() {
            this.opened = true;
            this.$('.panel').classList.add('open');
            this.refresh();
        }

        close() {
            this.opened = false;
            this.$('.panel').classList.remove('open');
        }

        setStatus(message, tone = 'normal') {
            const element = this.$('[data-role="status"]');
            if (!element) return;
            element.textContent = message;
            element.dataset.tone = tone;
            this.logs.unshift({ message, tone, at: Date.now() });
            this.logs = this.logs.slice(0, 10);
        }

        setAiStatus(message, tone = 'normal') {
            const element = this.$('[data-role="ai-status"]');
            if (element) {
                element.textContent = message;
                element.dataset.tone = tone;
            }
        }

        refresh() {
            if (!this.shadow) return;
            const session = this.store.load();
            const stats = this.store.stats(session);
            const mode = session?.mode || 'unknown';
            const modeText = mode === 'practice-vue'
                ? '随堂练习'
                : mode === 'long-page'
                    ? '长卷同页'
                    : mode === 'paged'
                        ? '逐题换页'
                        : mode === 'ai-paged'
                            ? 'AI 逐题'
                            : '等待识别';

            this.$('[data-role="mode"]').textContent = modeText;
            this.$('[data-role="paper-title"]').textContent = session?.paperTitle || document.title || '等待识别试卷';
            this.$('[data-stat="answers"]').textContent = String(stats.answerCount);
            this.$('[data-stat="processed"]').textContent = String(stats.processedCount);
            this.$('[data-stat="skipped"]').textContent = String(stats.skippedCount);
            this.$('[data-stat="total"]').textContent = stats.total || '—';

            const percent = stats.total
                ? Math.min(100, Math.round((stats.processedCount / stats.total) * 100))
                : stats.processedCount ? Math.min(95, stats.processedCount) : 0;
            this.$('[data-role="progress-bar"]').style.width = `${percent}%`;

            const startButton = this.$('[data-action="start"]');
            const pauseButton = this.$('[data-action="pause"]');
            const exportButtons = ['excel', 'markdown', 'json'].map(action => this.$(`[data-action="${action}"]`));
            startButton.disabled = Boolean(session?.active);
            startButton.textContent = session?.items?.length || session?.skipped?.length ? '继续采集' : '开始采集';
            pauseButton.disabled = !session?.active;
            exportButtons.filter(Boolean).forEach(button => { button.disabled = stats.questionCount === 0; });

            const skippedList = this.$('[data-role="skipped-list"]');
            const recent = (session?.skipped || []).slice(-4).reverse();
            skippedList.classList.toggle('visible', recent.length > 0);
            skippedList.innerHTML = recent.length
                ? `<strong>最近暂无答案</strong>${recent.map(item => `<div class="skipped-item">第 ${item.order || '?'} 题：${this.escape(item.reason)}</div>`).join('')}`
                : '';

            if (session?.active) {
                this.setStatus(`采集中：${stats.processedCount}${stats.total ? ` / ${stats.total}` : ''}，已获取 ${stats.answerCount} 个答案`, 'active');
            } else if (session?.phase === 'completed') {
                this.setStatus(`采集完成，共获取 ${stats.answerCount} 个正确答案`, 'success');
            } else if (session?.phase === 'error') {
                this.setStatus(session.message || '采集发生错误', 'error');
            } else if (session?.phase === 'paused') {
                this.setStatus(`已暂停，进度已保存：${stats.answerCount} 个正确答案`, 'normal');
            }
        }

        escape(value) {
            const element = document.createElement('div');
            element.textContent = String(value || '');
            return element.innerHTML;
        }
    }

    class Collector {
        constructor(adapter, store, settingsStore, ui) {
            this.adapter = adapter;
            this.store = store;
            this.settingsStore = settingsStore;
            this.ui = ui;
            this.busy = false;
            this.resumeTimer = null;
        }

        createSession(mode) {
            const session = this.store.create(mode);
            session.active = true;
            session.phase = mode === 'paged' ? 'positioning' : 'collecting';
            return session;
        }

        async start() {
            if (this.busy) return;
            const detectedMode = this.adapter.detectMode();
            let session = this.store.load();

            if (session?.active) {
                this.ui.setStatus('采集任务已经在运行', 'active');
                await this.resume();
                return;
            }

            if (detectedMode === 'practice-vue') {
                const hasOldData = Boolean(session?.items?.length || session?.skipped?.length);
                if (hasOldData && !confirm('检测到已有采集数据。随堂练习模式将重新读取当前活动并覆盖同题号内容，是否继续？')) return;
                session ||= this.createSession('practice-vue');
                session.mode = 'practice-vue';
                session.active = true;
                session.phase = 'collecting';
                session.total = Math.max(session.total || 0, this.adapter.detectTotal());
                this.store.save(session);
                await this.collectVuePractice();
                return;
            }

            if (detectedMode === 'long-page') {
                const hasOldData = Boolean(session?.items?.length || session?.skipped?.length);
                if (hasOldData && !confirm('检测到已有采集数据。长卷模式将重新扫描当前整页并合并覆盖同题号内容，是否继续？')) return;
                session ||= this.createSession('long-page');
                session.mode = 'long-page';
                session.active = true;
                session.phase = 'collecting';
                session.total = Math.max(session.total || 0, this.adapter.detectTotal(), this.adapter.getQuestionNodes().length);
                this.store.save(session);
                await this.collectLongPage();
                return;
            }

            if (session && (session.items.length || session.skipped.length)) {
                const stats = this.store.stats(session);
                const resume = confirm(`检测到已保存的进度：已处理 ${stats.processedCount} 题，已获取 ${stats.answerCount} 个答案。\n\n确定：从缺失题继续；取消：保留数据但不启动。`);
                if (!resume) {
                    this.ui.refresh();
                    return;
                }
                session.mode = 'paged';
                session.active = true;
                session.phase = 'resuming';
                session.targetOrder = this.store.firstMissing(session);
                session.message = '';
            } else {
                session = this.createSession('paged');
                const current = this.adapter.getCurrentOrder();
                session.targetOrder = current > 1 ? 1 : current || 1;
            }

            session.total = Math.max(session.total || 0, this.adapter.detectTotal());
            if (!this.store.save(session)) {
                this.ui.setStatus('无法保存采集进度，请检查浏览器存储空间', 'error');
                return;
            }
            this.ui.refresh();
            await this.resume();
        }

        pause(reason = '用户暂停采集') {
            const session = this.store.load();
            if (!session) return;
            session.active = false;
            session.phase = 'paused';
            session.message = reason;
            this.store.save(session);
            this.ui.refresh();
            this.ui.setStatus(`${reason}，当前进度已保存`, 'normal');
        }

        clear() {
            const session = this.store.load();
            const stats = this.store.stats(session);
            if ((stats.answerCount || stats.skippedCount) && !confirm(`将清空当前试卷的 ${stats.questionCount} 道题（其中 ${stats.answerCount} 道有答案、${stats.skippedCount} 道暂无答案），是否继续？`)) return;
            this.store.clear();
            this.ui.refresh();
            this.ui.setStatus('已清空当前试卷数据', 'normal');
        }

        finish(session, phase = 'completed', message = '') {
            session.active = false;
            session.phase = phase;
            session.message = message;
            session.completedAt = Date.now();
            session.pendingAnswerOrder = null;
            this.store.save(session);
            this.ui.refresh();
            const stats = this.store.stats(session);
            if (phase === 'completed') this.ui.setStatus(`采集完成：共采集 ${stats.questionCount} 道题，其中 ${stats.answerCount} 道有答案，${stats.skippedCount} 道暂无答案`, 'success');
            else if (phase === 'error') this.ui.setStatus(message || '采集失败', 'error');
            else this.ui.setStatus(message || '采集已暂停', 'normal');
        }

        async scanCurrentPage() {
            if (this.adapter.detectMode() === 'practice-vue') {
                await this.collectVuePractice();
                return;
            }
            if (this.busy) return;
            this.busy = true;
            try {
                const nodes = this.adapter.getQuestionNodes();
                if (!nodes.length) throw new Error('当前页面没有识别到题目');
                let session = this.store.load() || this.store.create(nodes.length > 1 ? 'long-page' : 'paged');
                session.mode = nodes.length > 1 ? 'long-page' : 'paged';
                session.total = Math.max(session.total || 0, this.adapter.detectTotal(), nodes.length);

                nodes.forEach((node, index) => {
                    const item = this.adapter.parseQuestion(node, index + 1);
                    if (!item) return;
                    if (item.answer) this.store.addItem(session, item);
                    else this.store.addSkipped(session, item, '当前页面未显示正确答案');
                });

                session.active = false;
                session.phase = 'paused';
                session.message = '已扫描当前页';
                this.store.save(session);
                this.ui.refresh();
                const stats = this.store.stats(session);
                this.ui.setStatus(`当前页扫描完成：共采集 ${stats.questionCount} 道题，其中 ${stats.answerCount} 道有答案；整卷请点击“开始 / 继续采集”`, 'success');
            } catch (error) {
                this.ui.setStatus(error.message || '扫描当前页失败', 'error');
            } finally {
                this.busy = false;
            }
        }

        async collectVuePractice() {
            if (this.busy) return;
            this.busy = true;
            try {
                this.ui.setStatus('正在读取随堂练习题目数据…', 'active');
                const context = await this.adapter.waitForVuePractice();
                if (!context) throw new Error('未读取到随堂练习的题目数据');

                const items = this.adapter.getVuePracticeItems();
                if (!items.length) throw new Error('随堂练习题目解析失败');

                let session = this.store.load() || this.createSession('practice-vue');
                session.mode = 'practice-vue';
                session.active = true;
                session.phase = 'collecting';
                session.paperTitle = this.adapter.getPaperTitle();
                session.total = Math.max(session.total || 0, items.length);

                for (const item of items) {
                    if (item.answer) this.store.addItem(session, item);
                    else this.store.addSkipped(session, item, '题目数据中未提供正确答案');
                }

                this.finish(session, 'completed');
            } catch (error) {
                const session = this.store.load() || this.store.create('practice-vue');
                this.finish(session, 'error', error.message || '随堂练习采集失败');
            } finally {
                this.busy = false;
            }
        }

        async settleLongPage() {
            const originalX = scrollX;
            const originalY = scrollY;
            let lastCount = 0;
            let stableRounds = 0;

            for (let round = 0; round < 20 && stableRounds < 2; round += 1) {
                const count = this.adapter.getQuestionNodes().length;
                if (count === lastCount) stableRounds += 1;
                else {
                    lastCount = count;
                    stableRounds = 0;
                }
                window.scrollTo(0, document.documentElement.scrollHeight);
                await sleep(180);
            }
            window.scrollTo(originalX, originalY);
            await sleep(100);
        }

        async collectLongPage() {
            if (this.busy) return;
            this.busy = true;
            try {
                this.ui.setStatus('正在等待长卷题目加载完成…', 'active');
                await this.settleLongPage();
                const nodes = this.adapter.getQuestionNodes();
                if (nodes.length <= 1) throw new Error('未检测到长卷页面，请改用逐题采集');

                let session = this.store.load() || this.createSession('long-page');
                session.active = true;
                session.mode = 'long-page';
                session.phase = 'collecting';
                session.total = Math.max(session.total || 0, this.adapter.detectTotal(), nodes.length);
                this.store.save(session);

                for (let index = 0; index < nodes.length; index += 1) {
                    session = this.store.load() || session;
                    if (!session.active) break;
                    const node = nodes[index];
                    let item = this.adapter.parseQuestion(node, index + 1);
                    if (!item) continue;

                    if (!item.answer) {
                        const loaded = await this.adapter.waitForAnswer(node, item.order || index + 1, APP.answerGraceTimeout);
                        if (loaded?.item) item = loaded.item;
                    }

                    const settings = this.settingsStore.load();
                    if (!item.answer && settings.autoRevealAnswer) {
                        const reveal = this.adapter.findShowAnswer(node);
                        if (reveal && this.adapter.isSafeInlineReveal(reveal)) {
                            reveal.click();
                            const revealed = await this.adapter.waitForAnswer(node, item.order || index + 1, APP.answerRevealTimeout);
                            if (revealed?.item) item = revealed.item;
                        }
                    }

                    if (item.answer) this.store.addItem(session, item);
                    else {
                        const reveal = this.adapter.findShowAnswer(node);
                        const reason = reveal && !this.adapter.isSafeInlineReveal(reveal)
                            ? '显示答案会离开长卷页面，已跳过'
                            : '未识别到正确答案';
                        this.store.addSkipped(session, item, reason);
                    }

                    session.lastOrder = item.order;
                    this.store.save(session);
                    this.ui.refresh();
                    if (index % 8 === 7) await sleep(40);
                }

                session = this.store.load() || session;
                if (session.active) this.finish(session, 'completed');
            } catch (error) {
                const session = this.store.load() || this.store.create('long-page');
                this.finish(session, 'error', error.message || '长卷采集失败');
            } finally {
                this.busy = false;
            }
        }

        navigationGuard(session, action) {
            const now = Date.now();
            const currentOrder = this.adapter.getCurrentOrder();
            // 基于题号是否变化来判断：如果 action 相同且题号也没变，才增加失败计数
            const orderUnchanged = currentOrder > 0 && Number(session.lastGuardedOrder) === currentOrder;
            if (session.lastAction === action && now - Number(session.lastActionAt || 0) < 30000 && orderUnchanged) {
                session.jumpAttempts[action] = Number(session.jumpAttempts[action] || 0) + 1;
            } else {
                session.jumpAttempts[action] = 1;
            }
            session.lastAction = action;
            session.lastActionAt = now;
            session.lastGuardedOrder = currentOrder;
            return session.jumpAttempts[action] <= APP.maxJumpAttempts;
        }

        navigate(element, session, action) {
            if (!element) return false;
            if (!this.navigationGuard(session, action)) {
                this.finish(session, 'error', `连续执行"${action}"仍未成功，已停止以避免循环刷新`);
                return false;
            }
            if (!this.store.save(session)) {
                this.finish(session, 'error', '无法保存进度，采集已停止');
                return false;
            }

            const oldHref = location.href;
            const previousSignature = this.adapter.getQuestionSignature();
            const previousOrder = this.adapter.getCurrentOrder();
            const targetOrder = Number(session.targetOrder) || 0;
            const settings = this.settingsStore.load();
            const delay = clampNumber(settings.collectionDelay, 0, 2000, APP.navigationDelay);
            const revealing = /^reveal-answer-/.test(action);

            setTimeout(() => {
                try {
                    element.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
                    element.click();
                } catch (error) {
                    const href = element.href || element.getAttribute?.('href');
                    if (href && !/^javascript:/i.test(href)) {
                        location.assign(href);
                        return;
                    }
                    console.error('[CXAE] 点击导航失败。', error);
                }

                // 同页切题不再固定等待 1.6 秒；题号、题干或答案一发生变化就继续。
                (async () => {
                    if (revealing) {
                        const node = this.adapter.getCurrentQuestionNode(previousOrder);
                        await this.adapter.waitForAnswer(node, previousOrder, APP.answerRevealTimeout);
                    } else {
                        await this.adapter.waitForQuestionSwitch(
                            previousSignature,
                            targetOrder,
                            APP.aiNavigationTimeout
                        );
                    }
                    const latest = this.store.load();
                    if (latest?.active && location.href === oldHref) this.resume();
                })();
            }, delay);
            return true;
        }

        async moveToTarget(session, target) {
            const current = await this.adapter.waitForStableCurrentOrder();
            if (current === target) {
                session.phase = 'collecting';
                session.targetOrder = null;
                this.store.save(session);
                return false;
            }

            if (!(current > 0)) {
                this.finish(session, 'error', `无法识别当前题号，已停止以避免反复刷新第 ${target} 题`);
                return false;
            }

            const navigation = this.adapter.findQuestionNavigationTarget(target, current);
            if (!navigation?.element) {
                const label = current < target ? '下一题' : '上一题';
                this.finish(session, 'error', `已识别到第 ${target} 题，但无法找到题号按钮或“${label}”控件`);
                return false;
            }

            session.phase = 'resuming';
            session.targetOrder = target;
            this.ui.setStatus(`正在从第 ${current} 题跳转到第 ${target} 题…`, 'active');
            return this.navigate(
                navigation.element,
                session,
                `恢复-${current}-${navigation.method}-${target}`
            );
        }

        async resume() {
            if (this.busy) return;
            let session = this.store.load();
            if (!session?.active || session.mode !== 'paged') return;
            this.busy = true;

            try {
                const question = await this.adapter.waitForQuestion();
                if (!question) {
                    this.finish(session, 'error', '页面加载后没有找到题目');
                    return;
                }

                session.total = Math.max(session.total || 0, this.adapter.detectTotal());

                if (session.phase === 'positioning' || session.phase === 'resuming') {
                    const target = Number(session.targetOrder) || this.store.firstMissing(session);
                    if (session.total && target > session.total) {
                        this.finish(session, 'completed');
                        return;
                    }
                    const navigationStarted = await this.moveToTarget(session, target);
                    if (navigationStarted || !session.active) return;
                    session = this.store.load() || session;
                }

                const currentOrder = await this.adapter.waitForStableCurrentOrder(6000);
                let currentNode = this.adapter.getCurrentQuestionNode(currentOrder);
                let item = this.adapter.parseQuestion(currentNode, currentOrder || 0);
                if (!item) {
                    this.finish(session, 'error', '当前可见题目解析失败');
                    return;
                }
                item.order ||= currentOrder;
                if (!(item.order > 0)) {
                    this.finish(session, 'error', '无法识别当前题号，已停止以避免重复采集');
                    return;
                }

                const isWaitingForReveal = session.phase === 'revealing' &&
                    Number(session.pendingAnswerOrder) === Number(item.order);
                if (!item.answer) {
                    const loaded = await this.adapter.waitForAnswer(
                        currentNode,
                        item.order,
                        isWaitingForReveal ? APP.answerRevealTimeout : APP.answerGraceTimeout
                    );
                    if (loaded?.item) {
                        currentNode = loaded.node || currentNode;
                        item = loaded.item;
                    }
                }

                const settings = this.settingsStore.load();
                if (!item.answer && settings.autoRevealAnswer && !isWaitingForReveal) {
                    const reveal = this.adapter.findShowAnswer();
                    const attempts = Number(session.revealAttempts[item.order] || 0);
                    if (reveal && attempts < APP.maxRevealAttempts) {
                        session.revealAttempts[item.order] = attempts + 1;
                        session.phase = 'revealing';
                        session.pendingAnswerOrder = item.order;
                        this.ui.setStatus(`第 ${item.order} 题未显示答案，正在点击"显示答案"…`, 'active');
                        this.navigate(reveal, session, `reveal-answer-${item.order}`);
                        return;
                    }
                }

                if (item.answer) this.store.addItem(session, item);
                else {
                    const reason = this.adapter.findShowAnswer()
                        ? '多次显示答案后仍未识别到正确答案'
                        : '页面没有正确答案，也没有显示答案按钮';
                    this.store.addSkipped(session, item, reason);
                }

                session.lastOrder = item.order;
                session.phase = 'collecting';
                session.pendingAnswerOrder = null;
                session.targetOrder = null;
                this.store.save(session);
                this.ui.refresh();

                const stats = this.store.stats(session);
                if (session.total && stats.processedCount >= session.total) {
                    this.finish(session, 'completed');
                    return;
                }

                const nextOrder = this.store.firstMissing(session);
                if (session.total && nextOrder > session.total) {
                    this.finish(session, 'completed');
                    return;
                }

                const navigation = this.adapter.findQuestionNavigationTarget(nextOrder, item.order);
                if (!navigation?.element) {
                    session.active = false;
                    session.phase = 'paused';
                    session.targetOrder = nextOrder;
                    session.message = `已采集第 ${item.order} 题，但检测到共 ${session.total || '?'} 题，无法找到第 ${nextOrder} 题的题号按钮或下一题控件`;
                    this.store.save(session);
                    this.ui.refresh();
                    this.ui.setStatus(session.message, 'error');
                    return;
                }

                session.phase = 'resuming';
                session.targetOrder = nextOrder;
                this.navigate(
                    navigation.element,
                    session,
                    `next-from${item.order}-${navigation.method}-to${nextOrder}`
                );
            } catch (error) {
                session = this.store.load() || session;
                this.finish(session, 'error', error.message || '跨页面采集失败');
            } finally {
                this.busy = false;
            }
        }

        autoResume() {
            clearTimeout(this.resumeTimer);
            const session = this.store.load();
            if (session?.active && session.mode === 'paged') {
                this.resumeTimer = setTimeout(() => this.resume(), 250);
            }
        }
    }

    const adapter = new ChaoxingAdapter();
    const settingsStore = new SettingsStore();
    const store = new SessionStore(adapter);
    const ui = new AppUI(store, settingsStore);
    const aiClient = new AIClient(settingsStore);
    const autoFiller = new AutoFiller(adapter, store, ui, aiClient, settingsStore);
    const collector = new Collector(adapter, store, settingsStore, ui);
    const exporter = new Exporter(store, settingsStore);

    function handleExport(method) {
        try {
            exporter[method]();
            ui.setStatus('导出任务已创建', 'success');
        } catch (error) {
            ui.setStatus(error.message || '导出失败', 'error');
        }
    }

    async function handleAiFill() {
        try {
            await autoFiller.aiAutoFill();
        } catch (error) {
            ui.setAiStatus(`AI 答题失败：${error.message || '未知错误'}`, 'error');
        }
    }

    async function handleFillCollected() {
        try {
            await autoFiller.fillFromCollected();
        } catch (error) {
            ui.setAiStatus(`回填失败：${error.message || '未知错误'}`, 'error');
        }
    }

    async function handleTestAi() {
        ui.setAiStatus('正在测试 AI 连接…', 'active');
        try {
            await aiClient.testConnection();
            ui.setAiStatus('AI 连接测试成功！', 'success');
        } catch (error) {
            ui.setAiStatus(`连接失败：${error.message || '未知错误'}`, 'error');
        }
    }

    function mount() {
        const isStudyTopPage = window.top === window && /\/mycourse\/studentstudy/i.test(location.href);
        if (!adapter.hasQuestions() && !isStudyTopPage) return false;
        ui.mount();
        ui.on('start', () => collector.start());
        ui.on('scan', () => collector.scanCurrentPage());
        ui.on('pause', () => collector.pause());
        ui.on('clear', () => collector.clear());
        ui.on('excel', () => handleExport('exportExcel'));
        ui.on('markdown', () => handleExport('exportMarkdown'));
        ui.on('json', () => handleExport('exportJson'));
        ui.on('ai-fill', () => handleAiFill());
        ui.on('fill-collected', () => handleFillCollected());
        ui.on('stop-fill', () => autoFiller.stop());
        ui.on('test-ai', () => handleTestAi());
        ui.on('settings', () => ui.refresh());
        collector.autoResume();
        autoFiller.autoResume();
        return true;
    }

    function initialize() {
        if (mount()) return;
        const observer = new MutationObserver(() => {
            if (mount()) {
                observer.disconnect();
                clearInterval(pollTimer);
            }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });

        const pollTimer = setInterval(() => {
            if (mount()) {
                observer.disconnect();
                clearInterval(pollTimer);
            }
        }, 500);

        setTimeout(() => {
            observer.disconnect();
            clearInterval(pollTimer);
        }, 60000);
    }

    // 给自动刷课模块/父页面调用：当课程页内嵌章节测验 iframe 时，父页面可以进入对应 frame 调用 AI 答题。
    // 只暴露必要能力，不改变原右侧浮窗的交互。
    try {
        window.cxAnswerExporter = {
            version: APP.version,
            hasQuestions: () => adapter.hasQuestions(),
            getAnswerTargets: () => adapter.getAnswerTargets(),
            aiAutoFill: () => handleAiFill(),
            fillFromCollected: () => handleFillCollected(),
            stop: () => autoFiller.stop(),
            mount,
            adapter,
            store,
            ui,
            aiClient,
            settingsStore,
            autoFiller,
            collector,
            exporter,
        };
    } catch (error) {
        console.warn('[CXAE] 暴露自动答题接口失败。', error);
    }

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            const session = store.load();
            const aiTask = autoFiller.loadTask();
            if (session?.active) {
                event.preventDefault();
                collector.pause('用户按 Esc 暂停采集');
            }
            if (autoFiller.busy || aiTask?.active) {
                event.preventDefault();
                autoFiller.stop();
            }
        }
    }, true);

    window.addEventListener('pageshow', () => {
        collector.autoResume();
        autoFiller.autoResume();
    });

    initialize();
})();

// == Chaoxing Study Auto Player module (combined) ==
(() => {
    'use strict';

    const MODULE = Object.freeze({
        id: 'cx-study-autoplayer',
        name: '学习通超级工具·自动刷课',
        version: '1.5.1',
        settingsKey: 'CX_STUDY_AUTOPLAYER_SETTINGS',
    });

    function isStudyPage() {
        return /\/mycourse\/studentstudy/i.test(location.href);
    }

    if (!isStudyPage()) return;
    if (window[MODULE.id]) return;

    const DEFAULT_SETTINGS = Object.freeze({
        enabled: true,
        playbackRate: 1.5,
        autoplay: true,
        retryInterval: 2000,
        maxRetries: 10,
        videoCheckInterval: 1000,
        guardNoProgressMs: 7000,
        guardResumeCooldownMs: 1500,
        switchDelay: 3000,
        skipQuiz: false,
        solveQuizWithAi: true,
        autoSubmitQuiz: true,
        quizWaitTimeout: 90000,
        quizSubmitDelay: 1200,
    });

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const normalizeText = value => String(value ?? '').replace(/\s+/g, '').trim();

    function loadSettings() {
        try {
            const parsed = JSON.parse(localStorage.getItem(MODULE.settingsKey) || '{}');
            return { ...DEFAULT_SETTINGS, ...parsed };
        } catch {
            return { ...DEFAULT_SETTINGS };
        }
    }

    function saveSettings(settings) {
        const merged = { ...DEFAULT_SETTINGS, ...(settings || {}) };
        try {
            localStorage.setItem(MODULE.settingsKey, JSON.stringify(merged));
        } catch (error) {
            console.warn(`[${MODULE.id}] 保存设置失败`, error);
        }
        return merged;
    }

    function isVisible(element) {
        if (!element || !element.isConnected) return false;
        const view = element.ownerDocument?.defaultView || window;
        const style = view.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
    }

    function clickElement(element) {
        if (!element) return false;
        try {
            const view = element.ownerDocument?.defaultView || window;
            element.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
            element.dispatchEvent(new view.MouseEvent('mouseover', { bubbles: true, cancelable: true, view }));
            element.dispatchEvent(new view.MouseEvent('mousedown', { bubbles: true, cancelable: true, view }));
            element.dispatchEvent(new view.MouseEvent('mouseup', { bubbles: true, cancelable: true, view }));
            element.dispatchEvent(new view.MouseEvent('click', { bubbles: true, cancelable: true, view }));
            return true;
        } catch (error) {
            console.warn(`[${MODULE.id}] 点击失败`, error);
            try { element.click(); return true; } catch { return false; }
        }
    }

    function getDocumentFromFrame(frame) {
        try {
            return frame?.contentDocument || frame?.contentWindow?.document || null;
        } catch {
            return null;
        }
    }

    class StudyAutoPlayer {
        constructor() {
            this.settings = loadSettings();
            this._videoEl = null;
            this._treeContainerEl = null;
            this._isPlaying = false;
            this._tryTimes = 0;
            this._checkInterval = null;
            this._stepSwitchAt = 0;
            this._stepSwitchPending = false;
            this._stepNavigationBound = false;
            this._delayedNextUnitTimer = null;
            this._guardLastTime = 0;
            this._guardLastWallTs = 0;
            this._guardLastResumeTs = 0;
            this._quizBusy = false;
            this._videoEndedHandling = false;
            this._controlPanel = null;
            this._keepAliveBound = false;
            this._cellData = {
                cells: 0,
                nCells: 0,
                currentCellIndex: 0,
                currentNCellIndex: 0,
                currentVideoTitle: '',
            };
        }

        get cellData() {
            return this._cellData;
        }

        run() {
            this._createControlPanel();
            if (!this.settings.enabled) {
                console.log(`%c=== ${MODULE.name} 已关闭；可在“学习通超级工具”主浮窗重新开启 ===`, 'color:#9E9E9E');
                return;
            }
            console.log(`%c=== ${MODULE.name} ${MODULE.version} 启动 ===`, 'color:#4CAF50;font-size:16px;font-weight:bold');
            this.waitForCourseTreeAndStart();
            this.bindPageKeepAlive();
        }

        waitForCourseTreeAndStart() {
            const startedAt = Date.now();
            const timer = setInterval(() => {
                if (document.querySelector('#coursetree')) {
                    clearInterval(timer);
                    this.start();
                    return;
                }
                if (Date.now() - startedAt > 60000) {
                    clearInterval(timer);
                    console.log(`[${MODULE.id}] 未找到课程目录，自动播放模块停止等待。`);
                }
            }, 500);
        }

        start() {
            try {
                this._getTreeContainer();
                this._initCellData();
                this._videoEl = null;
                this._bindStepNavigation();
                if (this.settings.autoplay) this.play();
            } catch (error) {
                console.error(`%c${MODULE.name} 运行失败：`, 'color:#F44336;font-weight:bold', error?.message || error);
            }
        }

        _stopAutomation() {
            this._isPlaying = false;
            this._quizBusy = false;
            this._videoEndedHandling = false;
            this._clearCheckInterval();
            if (this._delayedNextUnitTimer) {
                clearTimeout(this._delayedNextUnitTimer);
                this._delayedNextUnitTimer = null;
            }
            console.log(`%c${MODULE.name} 已暂停自动控制。`, 'color:#9E9E9E');
        }

        _updateSettings(patch = {}) {
            const beforeEnabled = Boolean(this.settings.enabled);
            this.settings = saveSettings({ ...this.settings, ...patch });
            this._refreshControlPanel();

            const video = this._getVideoEl?.();
            if (video && patch.playbackRate != null) {
                video.playbackRate = Number(this.settings.playbackRate) || DEFAULT_SETTINGS.playbackRate;
            }

            if (!this.settings.enabled) {
                this._stopAutomation();
                return;
            }

            if (!beforeEnabled && this.settings.enabled) {
                console.log(`%c${MODULE.name} 已开启。`, 'color:#4CAF50');
                this.waitForCourseTreeAndStart();
                this.bindPageKeepAlive();
            }
        }

        _createControlPanel() {
            // 自动刷课设置已经合并到“学习通超级工具”主浮窗，不再单独创建面板，避免两个 UI 互相遮挡。
        }

        _refreshControlPanel() {
            try {
                window.cxAnswerExporter?.ui?.applyStudySettings?.();
            } catch {}
        }

        _getTreeContainer() {
            if (!this._treeContainerEl || !this._treeContainerEl.isConnected) {
                const el = document.querySelector('#coursetree');
                if (!el) throw new Error('找不到视频列表 #coursetree');
                this._treeContainerEl = el;
            }
            return this._treeContainerEl;
        }

        _getTopLevelCells() {
            const tree = this._getTreeContainer();
            return Array.from(tree.querySelectorAll(':scope > ul > li'));
        }

        _getSubCells(cell) {
            return Array.from(cell?.querySelectorAll?.('.posCatalog_select:not(.firstLayer)') || []);
        }

        _initCellData() {
            const cells = this._getTopLevelCells();
            let nCellCounts = 0;
            let foundCurrent = false;

            cells.forEach((cell, i) => {
                const nCells = this._getSubCells(cell);
                nCellCounts += nCells.length;
                nCells.forEach((subCell, j) => {
                    if (subCell.classList.contains('posCatalog_active')) {
                        this._cellData.currentCellIndex = i;
                        this._cellData.currentNCellIndex = j;
                        foundCurrent = true;
                        const titleSpan = subCell.querySelector('.posCatalog_name');
                        this._cellData.currentVideoTitle = titleSpan?.getAttribute('title') || titleSpan?.textContent?.trim() || '';
                    }
                });
            });

            this._cellData.cells = cells.length;
            this._cellData.nCells = nCellCounts;

            if (!foundCurrent && nCellCounts > 0) {
                console.warn('%c未找到当前激活的视频节点，可能需要手动选择。', 'color:#FF9800');
            }
            console.log(`%c课程信息：${this._cellData.cells}章，${this._cellData.nCells}节，当前：第${this._cellData.currentCellIndex + 1}章第${this._cellData.currentNCellIndex + 1}节`, 'color:#607D8B');
        }

        _findVideoInDocument(doc) {
            if (!doc) return null;
            const direct = doc.querySelector('video#video_html5_api, video');
            if (direct) return direct;

            const insertFrames = Array.from(doc.querySelectorAll('iframe.ans-insertvideo-online, iframe[src*="insertvideo"], iframe[src*="video"]'));
            for (const frame of insertFrames) {
                const frameDoc = getDocumentFromFrame(frame);
                const video = frameDoc?.querySelector?.('video#video_html5_api, video');
                if (video) return video;
            }
            return null;
        }

        _getVideoEl() {
            if (this._videoEl && this._videoEl.isConnected) return this._videoEl;

            let video = this._findVideoInDocument(document);
            if (video) {
                this._videoEl = video;
                return video;
            }

            for (const frame of Array.from(document.querySelectorAll('iframe'))) {
                const frameDoc = getDocumentFromFrame(frame);
                video = this._findVideoInDocument(frameDoc);
                if (video) {
                    this._videoEl = video;
                    return video;
                }
            }
            return null;
        }

        _walkFrameContexts(rootWindow = window, depth = 0, result = []) {
            if (depth > 6 || !rootWindow) return result;
            let doc = null;
            try { doc = rootWindow.document; } catch { return result; }
            if (!doc?.documentElement) return result;
            result.push({ win: rootWindow, doc, depth, url: doc.location?.href || '' });
            for (const frame of Array.from(doc.querySelectorAll('iframe'))) {
                try {
                    const childWindow = frame.contentWindow;
                    const childDoc = getDocumentFromFrame(frame);
                    if (childWindow && childDoc?.documentElement) {
                        this._walkFrameContexts(childWindow, depth + 1, result);
                    }
                } catch { /* 跨域 frame 忽略 */ }
            }
            return result;
        }

        _docText(doc) {
            return String(doc?.body?.innerText || doc?.body?.textContent || '').replace(/\u00a0/g, ' ').trim();
        }

        _looksLikeQuizDoc(doc) {
            if (!doc) return false;
            const url = String(doc.location?.href || '');
            const text = this._docText(doc);
            if (/\/ananas\/modules\/work|\/mooc-ans\/api\/work|\/work\//i.test(url)) return true;
            if (doc.querySelector('iframe[src*="/ananas/modules/work"], iframe[src*="/mooc-ans/api/work"]')) return true;
            if (doc.querySelector('.TiMu, .newTiMu, .singleQuesId, .Zy_TItle, .question-item, .question-name, input.ofl-ipt')) return true;
            return /章节测验|章節測驗|单选题|單選題|多选题|多選題|判断题|判斷題|填空题|填空題/.test(text);
        }

        _hasAnswerableQuiz(doc) {
            if (!doc) return false;
            if (doc.querySelector('input[type="radio"], input[type="checkbox"], input[type="text"], textarea, [contenteditable="true"], input.ofl-ipt')) return true;
            if (doc.querySelector('li[role="option"], .Zy_ulTop li, .question-item li > .option-letter, .clearfix[role="option"]')) return true;
            return Boolean(this._findSubmitButton(doc));
        }

        _isCompletedQuiz(doc) {
            if (!doc || !this._looksLikeQuizDoc(doc)) return false;
            const text = this._docText(doc);
            const hasResultMarkers = /我的答案|我的答案：|本次成绩|本次成績|查看已批阅|查看已批閱|已批阅|已批閱|CorrectOrNot|scoreNum/.test(text) ||
                Boolean(doc.querySelector('.newAnswerBx, .myAnswerBx, .answerScore, .CorrectOrNot, .scoreNum'));
            const hasSubmit = Boolean(this._findSubmitButton(doc));
            const hasInputs = Boolean(doc.querySelector('input[type="radio"], input[type="checkbox"], input[type="text"], textarea, [contenteditable="true"], input.ofl-ipt'));
            return hasResultMarkers && !hasSubmit && !hasInputs;
        }

        _getQuizContexts() {
            return this._walkFrameContexts()
                .filter(context => this._looksLikeQuizDoc(context.doc))
                .map(context => ({
                    ...context,
                    answerable: this._hasAnswerableQuiz(context.doc),
                    completed: this._isCompletedQuiz(context.doc),
                    helper: context.win?.cxAnswerExporter || null,
                    textLength: this._docText(context.doc).length,
                }))
                .sort((left, right) => {
                    const leftScore = (left.helper ? 80 : 0) + (left.answerable ? 50 : 0) + (left.completed ? -60 : 0) + Math.min(left.textLength, 5000) / 1000;
                    const rightScore = (right.helper ? 80 : 0) + (right.answerable ? 50 : 0) + (right.completed ? -60 : 0) + Math.min(right.textLength, 5000) / 1000;
                    return rightScore - leftScore;
                });
        }

        _getPendingQuizContext() {
            return this._getQuizContexts().find(context => context.answerable && !context.completed) || null;
        }

        _hasCompletedQuizContext() {
            return this._getQuizContexts().some(context => context.completed);
        }

        async _waitForQuizHelper(context, timeout = this.settings.quizWaitTimeout || DEFAULT_SETTINGS.quizWaitTimeout) {
            const startedAt = Date.now();
            while (Date.now() - startedAt < timeout) {
                const helper = context?.win?.cxAnswerExporter;
                if (helper?.aiAutoFill && (helper.hasQuestions?.() || context.answerable || this._looksLikeQuizDoc(context.doc))) return helper;
                await sleep(500);
            }
            return context?.win?.cxAnswerExporter || null;
        }

        _findSubmitButton(doc) {
            if (!doc) return null;
            const nodes = Array.from(doc.querySelectorAll('button, a, input[type="button"], input[type="submit"], [role="button"], [onclick], .btn, .jb_btn, .submitBtn, .submit-btn, .saveBtn'));
            const candidates = [];
            for (const node of nodes) {
                if (!isVisible(node)) continue;
                const text = String(node.tagName === 'INPUT' ? node.value : node.innerText || node.textContent || '').replace(/\s+/g, '').trim();
                const hint = `${text} ${node.id || ''} ${node.className || ''} ${node.getAttribute?.('onclick') || ''}`;
                if (!/(提交|保存|完成|交卷|确定提交|確認提交|提交答案|保存答案|save|submit)/i.test(hint)) continue;
                if (/(AI讲解|AI講解|已完成|完成条件|完成條件|恢复全部设定|恢復全部設定|视频摘要|內容由AI生成|内容由AI生成)/i.test(hint)) continue;
                let score = 0;
                if (/提交|交卷|submit/i.test(hint)) score += 20;
                if (/保存|save/i.test(hint)) score += 12;
                if (/完成/i.test(hint)) score += 8;
                if (['BUTTON', 'A', 'INPUT'].includes(node.tagName)) score += 5;
                candidates.push({ node, score, text: hint });
            }
            candidates.sort((left, right) => right.score - left.score);
            return candidates[0]?.node || null;
        }

        async _clickConfirmButtons() {
            for (let round = 0; round < 6; round += 1) {
                let clicked = false;
                for (const context of this._walkFrameContexts()) {
                    const nodes = Array.from(context.doc.querySelectorAll('button, a, input[type="button"], input[type="submit"], [role="button"], [onclick], .layui-layer-btn0, .el-button--primary, .sure, .confirm'));
                    const target = nodes.find(node => {
                        if (!isVisible(node)) return false;
                        const text = String(node.tagName === 'INPUT' ? node.value : node.innerText || node.textContent || '').replace(/\s+/g, '').trim();
                        const hint = `${text} ${node.className || ''} ${node.id || ''}`;
                        return /^(确定|確認|确认|好的|是|提交|继续|知道了|OK)$/i.test(text) || /(layui-layer-btn0|el-button--primary|confirm|sure)/i.test(hint) && !/取消|关闭|關閉|cancel/i.test(hint);
                    });
                    if (target) {
                        console.log('%c检测到提交确认框，点击确认。', 'color:#607D8B');
                        clickElement(target);
                        clicked = true;
                    }
                }
                if (!clicked) return;
                await sleep(800);
            }
        }

        async _answerQuizIfPresent(reason = 'auto') {
            if (!this.settings.solveQuizWithAi) return false;
            if (this._quizBusy) return true;

            const context = this._getPendingQuizContext();
            if (!context) return false;

            this._quizBusy = true;
            this._clearCheckInterval();
            this._isPlaying = false;
            console.log(`%c检测到章节测验，开始 AI 作答（${reason}）。`, 'color:#673AB7;font-weight:bold');

            try {
                const helper = await this._waitForQuizHelper(context);
                if (!helper?.aiAutoFill) {
                    console.warn(`[${MODULE.id}] 找到测验 iframe，但没有找到 cxAnswerExporter 自动答题接口；请确认油猴允许在 iframe 中运行。`);
                    return false;
                }

                helper.mount?.();
                await helper.aiAutoFill();
                await sleep(Number(this.settings.quizSubmitDelay) || DEFAULT_SETTINGS.quizSubmitDelay);

                if (this.settings.autoSubmitQuiz) {
                    const submit = this._findSubmitButton(context.doc) || this._findSubmitButton(document);
                    if (submit) {
                        console.log('%cAI 回填完成，尝试提交章节测验。', 'color:#4CAF50');
                        clickElement(submit);
                        await sleep(1000);
                        await this._clickConfirmButtons();
                    } else {
                        console.log('%cAI 回填完成，但没有找到提交按钮；请手动确认提交。', 'color:#FF9800');
                    }
                }

                await sleep(1500);
                return true;
            } catch (error) {
                console.error(`[${MODULE.id}] 章节测验 AI 作答失败：`, error);
                return false;
            } finally {
                this._quizBusy = false;
            }
        }

        async _afterVideoEnded() {
            if (this._videoEndedHandling) return;
            this._videoEndedHandling = true;
            this._isPlaying = false;
            this._clearCheckInterval();
            try {
                await sleep(1000);
                await this._answerQuizIfPresent('video-ended');
                await sleep(1000);
                this.nextUnit();
            } finally {
                setTimeout(() => { this._videoEndedHandling = false; }, 5000);
            }
        }

        async play() {
            if (!this.settings.enabled) return;
            try {
                const video = this._getVideoEl();
                if (!video) {
                    if (await this._answerQuizIfPresent('no-video')) {
                        console.log('%c章节测验处理完成，准备进入下一节。', 'color:#4CAF50');
                        setTimeout(() => this.nextUnit(), 1500);
                        return;
                    }
                    if (this._hasCompletedQuizContext()) {
                        console.log('%c检测到章节测验已完成，进入下一节。', 'color:#4CAF50');
                        setTimeout(() => this.nextUnit(), 1000);
                        return;
                    }
                    if (this._advanceLearningStep()) {
                        console.log('%c当前不在视频页，已尝试切到“视频”学习步骤，2 秒后重试。', 'color:#607D8B');
                        setTimeout(() => this.play(), 2000);
                        return;
                    }
                    if (this.settings.skipQuiz) {
                        console.log('%c未找到视频，启用兼容模式：跳过章节测验/非视频步骤，2 秒后继续。', 'color:#607D8B');
                        const next = document.querySelector('#prevNextFocusNext');
                        clickElement(next);
                        setTimeout(() => this.play(), 2000);
                        return;
                    }
                    console.log(`[${MODULE.id}] 未找到视频元素。`);
                    return;
                }

                this._tryTimes = 0;
                this._isPlaying = true;
                this._videoEventHandle();
                video.playbackRate = Number(this.settings.playbackRate) || DEFAULT_SETTINGS.playbackRate;

                try {
                    await video.play();
                    console.log(`%c视频开始播放，倍速：${video.playbackRate}x`, 'color:#4CAF50');
                    this._startVideoMonitoring();
                } catch (playError) {
                    console.error('视频播放失败：', playError);
                    this._handlePlayError(playError);
                }
            } catch (error) {
                if (this._tryTimes > Number(this.settings.maxRetries || DEFAULT_SETTINGS.maxRetries)) {
                    console.error('%c视频播放失败，已达到最大重试次数。', 'color:#F44336;font-weight:bold', error);
                    this._clearCheckInterval();
                    return;
                }
                this._tryTimes += 1;
                const interval = Number(this.settings.retryInterval) || DEFAULT_SETTINGS.retryInterval;
                console.log(`%c播放失败，${interval / 1000} 秒后重试（${this._tryTimes}/${this.settings.maxRetries}）`, 'color:#FF9800');
                setTimeout(() => this.play(), interval);
            }
        }

        _advanceLearningStep() {
            if (this._stepSwitchPending && Date.now() - this._stepSwitchAt < 4000) return true;

            const prevTitle = document.querySelector('.prev_title');
            const currentStepTitle = (prevTitle?.title || prevTitle?.textContent || '').trim();
            if (currentStepTitle === '章节测验' || currentStepTitle === '视频') return false;

            const videoTab = Array.from(document.querySelectorAll('.prev_white'))
                .filter(isVisible)
                .find(el => {
                    const text = normalizeText(el.textContent || '');
                    return text === '2视频' || text === '视频';
                });
            if (!videoTab) return false;

            this._stepSwitchPending = true;
            this._stepSwitchAt = Date.now();
            console.log('%c尝试点击“视频”页签。', 'color:#2196F3');
            return clickElement(videoTab);
        }

        _bindStepNavigation() {
            if (this._stepNavigationBound) return;
            this._stepNavigationBound = true;
            document.addEventListener('click', event => {
                const target = event.target?.closest?.('.prev_white');
                if (!target) return;
                const text = normalizeText(target.textContent || '');
                if (!text.includes('视频')) return;
                console.log(`%c检测到步骤切换点击：${text}，准备重新接管视频页。`, 'color:#607D8B');
                this._videoEl = null;
                this._isPlaying = false;
                this._stepSwitchPending = true;
                this._stepSwitchAt = Date.now();
                setTimeout(() => {
                    try { this._initCellData(); } catch {}
                    this.play();
                }, 1800);
            }, true);
        }

        _clearCheckInterval() {
            if (this._checkInterval) {
                clearInterval(this._checkInterval);
                this._checkInterval = null;
            }
        }

        _startVideoMonitoring() {
            this._clearCheckInterval();
            this._guardLastTime = 0;
            this._guardLastWallTs = 0;
            this._guardLastResumeTs = 0;
            const interval = Number(this.settings.videoCheckInterval) || DEFAULT_SETTINGS.videoCheckInterval;
            this._checkInterval = setInterval(() => this._checkVideoStatus(), interval);
        }

        _tryResumePlayback(reason) {
            const now = Date.now();
            if (now - this._guardLastResumeTs < Number(this.settings.guardResumeCooldownMs || DEFAULT_SETTINGS.guardResumeCooldownMs)) return;
            this._guardLastResumeTs = now;

            const video = this._getVideoEl();
            if (!video || !this._isPlaying) return;

            console.log(`%c触发视频保活恢复（${reason}）`, 'color:#607D8B');
            video.play().catch(error => {
                console.warn('直接恢复播放失败，尝试静音恢复：', error);
                video.muted = true;
                video.play().catch(err => console.error('静音恢复播放失败：', err));
            });
        }

        _checkVideoStatus() {
            try {
                const video = this._getVideoEl();
                if (!video) return;

                if (video.paused && this._isPlaying) {
                    console.log('%c检测到视频暂停，尝试恢复播放。', 'color:#FF5722');
                    this._tryResumePlayback('paused');
                } else if (this._isPlaying && !video.ended) {
                    const now = Date.now();
                    const current = Number(video.currentTime || 0);
                    if (this._guardLastWallTs === 0) {
                        this._guardLastWallTs = now;
                        this._guardLastTime = current;
                    } else {
                        const stalled = Math.abs(current - this._guardLastTime) < 0.01;
                        const stalledMs = now - this._guardLastWallTs;
                        if (stalled && stalledMs >= Number(this.settings.guardNoProgressMs || DEFAULT_SETTINGS.guardNoProgressMs)) {
                            this._tryResumePlayback('no-progress');
                            this._guardLastWallTs = now;
                            this._guardLastTime = Number(video.currentTime || 0);
                        } else if (!stalled) {
                            this._guardLastWallTs = now;
                            this._guardLastTime = current;
                        }
                    }
                }

                if (video.ended && this._isPlaying) {
                    console.log('%c检测到视频结束，准备检查章节测验/切换下一个。', 'color:#9C27B0');
                    this._afterVideoEnded();
                }
            } catch (error) {
                console.error('视频状态检查失败：', error);
            }
        }

        nextUnit() {
            console.log('%c=== 准备切换到下一小节 ===', 'color:#2196F3;font-size:14px');
            const cells = this._getTopLevelCells();
            const currentCell = cells[this._cellData.currentCellIndex];
            const nCells = this._getSubCells(currentCell);

            if (nCells.length > this._cellData.currentNCellIndex + 1) {
                const nextNIndex = this._cellData.currentNCellIndex + 1;
                console.log(`%c切换到同章节下一个视频：${nextNIndex + 1}/${nCells.length}`, 'color:#FF9800');
                this.playCurrentIndex(nCells[nextNIndex]);
                return;
            }

            const nextIndex = this._cellData.currentCellIndex + 1;
            if (nextIndex >= cells.length) {
                console.log('%c=====================================', 'color:#4CAF50;font-size:16px');
                console.log('%c==============本课程学习完成了==============', 'color:#4CAF50;font-size:16px;font-weight:bold');
                console.log('%c=====================================', 'color:#4CAF50;font-size:16px');
                this._clearCheckInterval();
                return;
            }

            console.log(`%c切换到下一个章节：${nextIndex + 1}/${cells.length}`, 'color:#FF9800');
            this._cellData.currentCellIndex = nextIndex;
            this._cellData.currentNCellIndex = 0;
            this.playCurrentIndex();
        }

        playCurrentIndex(nCell = null) {
            if (!nCell) {
                const cells = this._getTopLevelCells();
                const currentCell = cells[this._cellData.currentCellIndex];
                const nCells = this._getSubCells(currentCell);
                nCell = nCells[this._cellData.currentNCellIndex];
            }

            const clickable = nCell?.querySelector?.('.posCatalog_name') || nCell;
            if (!clickable) {
                console.error('%c找不到可点击的课程节点，播放下一个视频失败。', 'color:#F44336');
                setTimeout(() => this.nextUnit(), 2000);
                return;
            }

            console.log(`%c点击切换到：${clickable.getAttribute?.('title') || clickable.textContent?.trim() || '未知标题'}`, 'color:#2196F3');
            clickElement(clickable);
            this._videoEl = null;
            this._isPlaying = false;
            console.log('%c等待视频加载。', 'color:#FF9800');
            setTimeout(() => {
                this._initCellData();
                if (this.settings.autoplay) this.play();
            }, Number(this.settings.switchDelay) || DEFAULT_SETTINGS.switchDelay);
        }

        _handlePlayError(error) {
            console.error('播放错误详情：', error);
            const video = this._getVideoEl();
            if (!video) return;
            video.muted = true;
            video.play().then(() => {
                console.log('%c静音播放成功。', 'color:#4CAF50');
                if (this._delayedNextUnitTimer) {
                    clearTimeout(this._delayedNextUnitTimer);
                    this._delayedNextUnitTimer = null;
                }
            }).catch(err => {
                console.error('静音播放也失败：', err);
                if (this._delayedNextUnitTimer) clearTimeout(this._delayedNextUnitTimer);
                this._delayedNextUnitTimer = setTimeout(() => {
                    this._delayedNextUnitTimer = null;
                    this.nextUnit();
                }, 3000);
            });
        }

        _videoEventHandle() {
            const video = this._videoEl;
            if (!video) return;
            if (this._boundVideoEl === video) return;
            this._boundVideoEl = video;
            video.addEventListener('ended', () => {
                const title = this._cellData.currentVideoTitle;
                console.warn(`%c============ “${title}” 播放完成，检查章节测验 =============`, 'color:#4CAF50;font-weight:bold');
                this._afterVideoEnded();
            });
            video.addEventListener('loadedmetadata', () => {
                console.log('%c============ 视频加载完成 =============', 'color:#2196F3');
                if (this.settings.autoplay && !this._isPlaying) this.play();
            });
            video.addEventListener('play', () => {
                const title = this._cellData.currentVideoTitle;
                console.info(`%c============ “${title}” 开始播放 =============`, 'color:#4CAF50');
                this._isPlaying = true;
                this._stepSwitchPending = false;
                const current = this._getVideoEl();
                this._guardLastTime = Number(current?.currentTime || 0);
                this._guardLastWallTs = Date.now();
                if (this._delayedNextUnitTimer) {
                    clearTimeout(this._delayedNextUnitTimer);
                    this._delayedNextUnitTimer = null;
                }
            });
            video.addEventListener('pause', () => {
                console.log('%c============ 视频暂停 =============', 'color:#FF9800');
            });
        }

        bindPageKeepAlive() {
            if (this._keepAliveBound) return;
            this._keepAliveBound = true;
            const resumePlaybackNow = () => this._tryResumePlayback('page-event');
            const preventPause = event => {
                if (!this._isPlaying) return;
                event.stopPropagation();
            };
            document.addEventListener('mouseleave', preventPause, true);
            window.addEventListener('mouseleave', preventPause, true);
            document.addEventListener('mouseout', preventPause, true);
            window.addEventListener('mouseout', preventPause, true);
            window.addEventListener('blur', () => {
                console.log('%c页面失去焦点，保持播放状态。', 'color:#607D8B');
                resumePlaybackNow();
            });
            document.addEventListener('visibilitychange', () => {
                if (document.hidden) console.log('%c页面切到后台，尝试保持播放状态。', 'color:#607D8B');
                resumePlaybackNow();
            });
        }
    }

    const player = new StudyAutoPlayer();
    window[MODULE.id] = player;
    window.cxStudyAutoPlayer = player;
    player.run();
})();
