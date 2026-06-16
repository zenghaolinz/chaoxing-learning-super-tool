// ==UserScript==
// @name         超星答案导出器
// @namespace    https://github.com/zenghaolinz/chaoxing-answer-exporter
// @version      1.1.0
// @description  采集超星学习通题目与正确答案，支持逐题换页、长卷同页、随堂练习、显示答案跳转和断点恢复
// @author       zenghaolinz
// @license      MIT
// @homepageURL  https://github.com/zenghaolinz/chaoxing-answer-exporter
// @supportURL   https://github.com/zenghaolinz/chaoxing-answer-exporter/issues
// @downloadURL  https://raw.githubusercontent.com/zenghaolinz/chaoxing-answer-exporter/main/chaoxing-answer-exporter.user.js
// @updateURL    https://raw.githubusercontent.com/zenghaolinz/chaoxing-answer-exporter/main/chaoxing-answer-exporter.user.js
// @match        *://*.chaoxing.com/*
// @require      https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
    'use strict';

    const APP = Object.freeze({
        id: 'cx-answer-exporter',
        name: '超星答案导出器',
        version: '1.1.0',
        storageVersion: 1,
        sessionPrefix: 'CXAE_SESSION_',
        settingsKey: 'CXAE_SETTINGS',
        maxRevealAttempts: 3,
        maxJumpAttempts: 2,
        navigationDelay: 650,
        questionWaitTimeout: 15000,
    });

    const DEFAULT_SETTINGS = Object.freeze({
        autoRevealAnswer: true,
        includeTimestamp: true,
    });

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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
                return { ...DEFAULT_SETTINGS, ...parsed };
            } catch (error) {
                console.warn('[CXAE] 读取设置失败，使用默认值。', error);
                return { ...DEFAULT_SETTINGS };
            }
        }

        save(settings) {
            localStorage.setItem(APP.settingsKey, JSON.stringify(settings));
        }
    }

    class ChaoxingAdapter {
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
            const instances = [];
            const seen = new Set();
            const direct = document.querySelector('#main')?.__vue__;
            if (direct) {
                instances.push(direct);
                seen.add(direct);
            }

            for (const element of document.querySelectorAll('*')) {
                const vm = element.__vue__;
                if (!vm || seen.has(vm)) continue;
                seen.add(vm);
                instances.push(vm);
            }

            for (const vm of instances) {
                const data = vm?.$data;
                const list = data?.questionList;
                if (Array.isArray(list) && list.length > 0) {
                    return { vm, data, list };
                }
            }
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
            const primary = Array.from(document.querySelectorAll('.questionLi'));
            const candidates = primary.length ? primary : Array.from(document.querySelectorAll('.mark_item'));
            const result = [];
            const signatures = new Set();

            for (const node of candidates) {
                const titleNode = this.findTitleNode(node);
                const title = normalizeText(titleNode?.textContent || '');
                const text = title || normalizeText(node.textContent).slice(0, 300);
                if (!text) continue;

                const signature = `${title}|${text.slice(0, 120)}`;
                if (signatures.has(signature)) continue;
                signatures.add(signature);
                result.push(node);
            }

            return result;
        }

        hasQuestions() {
            return this.hasVuePracticeQuestions() || this.getQuestionNodes().length > 0;
        }

        findTitleNode(question) {
            return question?.querySelector(
                '.mark_name, [class*="mark_name"], .question-title, .questionTitle, .subject-title, .title'
            ) || null;
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

        inferQuestionType(title) {
            const match = String(title || '').match(/[（(]\s*([^）)]+题)\s*[）)]/);
            return match ? normalizeText(match[1]) : '未分类';
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
                .replace(/^\s*正确答案\s*[:：]?\s*/i, '')
                .replace(/\s*(?:答案解析|题目解析|难易度|知识点)\s*[:：]?.*$/s, '')
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

            const labeled = this.cleanAnswer(
                this.getLabeledSection(
                    question,
                    '正确答案',
                    ['答案解析', '题目解析', '难易度', '知识点', '上一题', '下一题']
                )
            );
            if (labeled) return labeled;

            const fullText = String(question.innerText || question.textContent || '').replace(/\r/g, '');
            const lineMatch = fullText.match(/(?:^|\n)\s*正确答案\s*[:：]\s*([^\n]+)/);
            if (lineMatch) {
                const value = this.cleanAnswer(lineMatch[1]);
                if (value) return value;
            }

            const labels = Array.from(question.querySelectorAll('span, div, p, i, b, strong'))
                .filter(element => /^正确答案\s*[:：]?$/.test(normalizeText(element.textContent)));

            for (const label of labels) {
                let sibling = label.nextElementSibling;
                for (let index = 0; sibling && index < 4; index += 1, sibling = sibling.nextElementSibling) {
                    const value = this.cleanAnswer(sibling.textContent);
                    if (value) return value;
                }

                const parentMatch = String(label.parentElement?.innerText || '').match(/正确答案\s*[:：]?\s*([^\n]+)/);
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
                '.option-item',
                '.answer-option',
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

        parseQuestion(question, fallbackOrder = 0) {
            if (!question) return null;
            const titleNode = this.findTitleNode(question);
            let title = normalizeText(titleNode?.innerText || titleNode?.textContent);

            if (!title) {
                const lines = this.getLines(question);
                title = lines.find(line => !/^(我的答案|正确答案|答案解析|题目解析|难易度|知识点)/.test(line)) || '';
            }
            if (!title) return null;

            const order = this.extractQuestionNumber(title) ||
                this.extractQuestionNumber(question.innerText || question.textContent) ||
                fallbackOrder;

            return {
                order,
                type: this.inferQuestionType(title),
                question: title,
                options: this.extractOptions(question),
                answer: this.extractAnswer(question),
                images: this.extractImages(question),
                sourceUrl: location.href,
            };
        }

        detectMode() {
            if (this.hasVuePracticeQuestions()) return 'practice-vue';
            return this.getQuestionNodes().length > 1 ? 'long-page' : 'paged';
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

            const navNumbers = Array.from(document.querySelectorAll('a, button, [onclick], [role="button"]'))
                .map(element => normalizeText(element.textContent))
                .filter(textValue => /^\d{1,5}$/.test(textValue))
                .map(Number);
            if (navNumbers.length >= 5) values.push(Math.max(...navNumbers));

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
            const question = this.getQuestionNodes()[0];
            const parsed = question ? this.parseQuestion(question) : null;
            return Number(parsed?.order) || this.getActiveQuestionNumber() || 0;
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
            return Array.from(document.querySelectorAll('a, button, input, [role="button"]'))
                .find(element => {
                    const text = element.tagName === 'INPUT'
                        ? normalizeText(element.value)
                        : normalizeText(element.innerText || element.textContent);
                    return text === label && isVisible(element) && !isDisabled(element);
                }) || null;
        }

        findNumberButton(number) {
            const target = String(number);
            const candidates = Array.from(document.querySelectorAll('a, button, [onclick], [role="button"]'))
                .filter(element => normalizeText(element.textContent) === target)
                .filter(isVisible)
                .map(element => {
                    let score = 0;
                    const onclick = String(element.getAttribute('onclick') || '');
                    const className = String(element.className || '');
                    if (/getThe|question|exam|test/i.test(onclick)) score += 4;
                    if (/question|answer|num|topic|subject|jb_/i.test(className)) score += 2;
                    const numericSiblings = element.parentElement
                        ? Array.from(element.parentElement.children)
                            .filter(child => /^\d+$/.test(normalizeText(child.textContent))).length
                        : 0;
                    if (numericSiblings >= 5) score += 3;
                    return { element, score };
                })
                .sort((left, right) => right.score - left.score);

            return candidates.length && candidates[0].score >= 2 ? candidates[0].element : null;
        }

        isSafeInlineReveal(button) {
            if (!button) return false;
            const href = String(button.getAttribute('href') || '').trim();
            if (href && !/^(?:#|javascript:|javascript:void\(0\);?)$/i.test(href)) return false;
            const onclick = String(button.getAttribute('onclick') || '');
            return !/window\.location|location\s*[.=]|window\.open|document\.location|submit\s*\(|getTheNextQuestion/i.test(onclick);
        }

        async waitForQuestion(timeout = APP.questionWaitTimeout) {
            const startedAt = Date.now();
            while (Date.now() - startedAt < timeout) {
                const nodes = this.getQuestionNodes();
                if (nodes.length && normalizeText(nodes[0].textContent)) return nodes[0];
                await sleep(250);
            }
            return null;
        }

        async waitForStableCurrentOrder(timeout = APP.questionWaitTimeout) {
            const startedAt = Date.now();
            let last = 0;
            let hits = 0;

            while (Date.now() - startedAt < timeout) {
                const value = this.getCurrentOrder();
                if (value > 0) {
                    if (value === last) hits += 1;
                    else {
                        last = value;
                        hits = 1;
                    }
                    if (hits >= 2) return value;
                }
                await sleep(250);
            }
            return last;
        }

        getPaperTitle() {
            const practiceTitle = this.getVuePracticeContext()?.data?.active?.name;
            return normalizeText(
                practiceTitle || document.querySelector('.mark_title, .testTit, .exam-title, h1')?.textContent || document.title
            ).replace(/[-_|]\s*超星.*$/i, '') || '超星题目';
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
            if (!session) return { answerCount: 0, skippedCount: 0, processedCount: 0, total: 0 };
            const processed = new Set((session.processedOrders || []).map(Number).filter(value => value > 0));
            session.items.forEach(item => { if (Number(item.order) > 0) processed.add(Number(item.order)); });
            session.skipped.forEach(item => { if (Number(item.order) > 0) processed.add(Number(item.order)); });
            return {
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
            const itemKey = item.order ? `order:${item.order}` : `question:${item.question}`;
            const index = session.items.findIndex(existing => {
                const existingKey = existing.order ? `order:${existing.order}` : `question:${existing.question}`;
                return existingKey === itemKey;
            });
            if (index >= 0) session.items[index] = item;
            else session.items.push(item);
            session.items.sort((left, right) => (left.order || 0) - (right.order || 0));
            session.skipped = session.skipped.filter(record => Number(record.order) !== Number(item.order));
            this.markProcessed(session, item.order);
        }

        addSkipped(session, item, reason) {
            const order = Number(item?.order) || 0;
            const record = { order, question: item?.question || '', reason: reason || '未读取到正确答案' };
            const index = session.skipped.findIndex(existing => order > 0 && Number(existing.order) === order);
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
                .filter(item => normalizeText(item.answer))
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
            if (!items.length) throw new Error('没有可导出的正确答案');
            if (typeof XLSX === 'undefined') throw new Error('Excel 组件尚未加载，请检查网络后刷新页面');

            const rows = items.map(item => ({
                '序号': item.order || '',
                '题型': item.type || '未分类',
                '题目': item.question,
                '选项': (item.options || []).join('\n'),
                '正确答案': item.answer,
                '图片链接': (item.images || []).join('\n'),
            }));

            const worksheet = XLSX.utils.json_to_sheet(rows);
            worksheet['!cols'] = [
                { wch: 8 },
                { wch: 14 },
                { wch: 60 },
                { wch: 45 },
                { wch: 22 },
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
            if (!items.length) throw new Error('没有可导出的正确答案');
            const payload = {
                title: session?.paperTitle || '超星题目',
                exportedAt: new Date().toISOString(),
                total: session?.total || items.length,
                collected: items.length,
                questions: items,
            };
            downloadBlob(JSON.stringify(payload, null, 2), `${this.baseFilename()}.json`, 'application/json;charset=utf-8');
        }

        exportMarkdown() {
            const session = this.store.load();
            const items = this.getItems();
            if (!items.length) throw new Error('没有可导出的正确答案');

            const lines = [`# ${session?.paperTitle || '超星题目'}`, ''];
            items.forEach(item => {
                lines.push(`## ${item.order || ''}. ${item.question}`.replace(/^## \./, '##'));
                if (item.type) lines.push(`- 题型：${item.type}`);
                if (item.options?.length) {
                    lines.push('', ...item.options.map(option => `- ${option}`));
                }
                lines.push('', `**正确答案：${item.answer}**`, '');
                if (item.images?.length) {
                    lines.push(...item.images.map(url => `- 图片：${url}`), '');
                }
            });
            downloadBlob(lines.join('\n'), `${this.baseFilename()}.md`, 'text/markdown;charset=utf-8');
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
                }
            `;

            const wrapper = document.createElement('div');
            wrapper.innerHTML = `
                <button class="launcher" type="button" aria-label="打开${APP.name}" title="打开${APP.name}">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M5 3h11a3 3 0 0 1 3 3v13.5a1.5 1.5 0 0 1-2.28 1.28L12 18l-4.72 2.78A1.5 1.5 0 0 1 5 19.5V3Zm3 4v2h8V7H8Zm0 4v2h8v-2H8Z"/></svg>
                </button>
                <section class="panel" role="dialog" aria-label="${APP.name}">
                    <header class="header">
                        <div class="logo">答</div>
                        <div class="heading">
                            <h2 class="title">${APP.name}</h2>
                            <div class="subtitle" data-role="paper-title">等待识别试卷</div>
                        </div>
                        <button class="icon-btn" type="button" data-action="close" aria-label="关闭">×</button>
                    </header>
                    <main class="content">
                        <div class="mode-row">
                            <span class="badge" data-role="mode">等待题目</span>
                            <span class="scope" data-role="scope">仅保存题目与正确答案</span>
                        </div>

                        <section class="card">
                            <div class="stats">
                                <div class="stat"><span class="stat-value" data-stat="answers">0</span><span class="stat-label">已获答案</span></div>
                                <div class="stat"><span class="stat-value" data-stat="processed">0</span><span class="stat-label">已处理</span></div>
                                <div class="stat"><span class="stat-value" data-stat="skipped">0</span><span class="stat-label">跳过</span></div>
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
                                <button class="button" type="button" data-action="scan">扫描当前页</button>
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
                            <h3 class="section-title">设置</h3>
                            <div class="settings">
                                <label class="setting"><span>未作答题自动点击“显示答案”</span><span class="switch"><input type="checkbox" data-setting="autoRevealAnswer"><span></span></span></label>
                                <label class="setting"><span>导出文件名添加时间</span><span class="switch"><input type="checkbox" data-setting="includeTimestamp"><span></span></span></label>
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
                input.addEventListener('change', () => {
                    const settings = this.settingsStore.load();
                    settings[input.dataset.setting] = input.checked;
                    this.settingsStore.save(settings);
                    this.handlers.settings?.(settings);
                });
            });
        }

        on(action, handler) {
            this.handlers[action] = handler;
        }

        applySettings() {
            const settings = this.settingsStore.load();
            this.shadow.querySelectorAll('[data-setting]').forEach(input => {
                input.checked = Boolean(settings[input.dataset.setting]);
            });
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
            exportButtons.forEach(button => { button.disabled = stats.answerCount === 0; });

            const skippedList = this.$('[data-role="skipped-list"]');
            const recent = (session?.skipped || []).slice(-4).reverse();
            skippedList.classList.toggle('visible', recent.length > 0);
            skippedList.innerHTML = recent.length
                ? `<strong>最近跳过</strong>${recent.map(item => `<div class="skipped-item">第 ${item.order || '?'} 题：${this.escape(item.reason)}</div>`).join('')}`
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
            if ((stats.answerCount || stats.skippedCount) && !confirm(`将清空当前试卷的 ${stats.answerCount} 个答案和 ${stats.skippedCount} 条跳过记录，是否继续？`)) return;
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
            if (phase === 'completed') this.ui.setStatus(`采集完成：${stats.answerCount} 个正确答案，跳过 ${stats.skippedCount} 题`, 'success');
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
                this.ui.setStatus(`当前页扫描完成：获取 ${stats.answerCount} 个正确答案`, 'success');
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

            for (let round = 0; round < 18 && stableRounds < 3; round += 1) {
                const count = this.adapter.getQuestionNodes().length;
                if (count === lastCount) stableRounds += 1;
                else {
                    lastCount = count;
                    stableRounds = 0;
                }
                window.scrollTo(0, document.documentElement.scrollHeight);
                await sleep(350);
            }
            window.scrollTo(originalX, originalY);
            await sleep(200);
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
                        for (let wait = 0; wait < 6; wait += 1) {
                            await sleep(180);
                            item = this.adapter.parseQuestion(node, index + 1) || item;
                            if (item.answer) break;
                        }
                    }

                    const settings = this.settingsStore.load();
                    if (!item.answer && settings.autoRevealAnswer) {
                        const reveal = this.adapter.findShowAnswer(node);
                        if (reveal && this.adapter.isSafeInlineReveal(reveal)) {
                            reveal.click();
                            for (let wait = 0; wait < 15; wait += 1) {
                                await sleep(220);
                                item = this.adapter.parseQuestion(node, index + 1) || item;
                                if (item.answer) break;
                            }
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
            if (session.lastAction === action && now - Number(session.lastActionAt || 0) < 30000) {
                session.jumpAttempts[action] = Number(session.jumpAttempts[action] || 0) + 1;
            } else {
                session.jumpAttempts[action] = 1;
            }
            session.lastAction = action;
            session.lastActionAt = now;
            return session.jumpAttempts[action] <= APP.maxJumpAttempts;
        }

        navigate(element, session, action) {
            if (!element) return false;
            if (!this.navigationGuard(session, action)) {
                this.finish(session, 'error', `连续执行“${action}”仍未成功，已停止以避免循环刷新`);
                return false;
            }
            if (!this.store.save(session)) {
                this.finish(session, 'error', '无法保存进度，采集已停止');
                return false;
            }

            const oldHref = location.href;
            setTimeout(() => {
                try {
                    element.click();
                } catch (error) {
                    const href = element.href || element.getAttribute?.('href');
                    if (href && !/^javascript:/i.test(href)) location.assign(href);
                    else console.error('[CXAE] 点击导航失败。', error);
                }

                setTimeout(() => {
                    const latest = this.store.load();
                    if (latest?.active && location.href === oldHref) this.resume();
                }, 1600);
            }, APP.navigationDelay);
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

            const direct = this.adapter.findNumberButton(target);
            if (direct) {
                session.phase = 'resuming';
                session.targetOrder = target;
                this.ui.setStatus(`正在从第 ${current} 题跳转到第 ${target} 题…`, 'active');
                return this.navigate(direct, session, `跳转第${target}题`);
            }

            const label = current < target ? '下一题' : '上一题';
            const button = this.adapter.findNavigation(label);
            if (!button) {
                this.finish(session, 'error', `无法找到“${label}”按钮以恢复到第 ${target} 题`);
                return false;
            }
            session.phase = 'resuming';
            session.targetOrder = target;
            return this.navigate(button, session, `恢复-${label}-${target}`);
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
                let item = this.adapter.parseQuestion(this.adapter.getQuestionNodes()[0], currentOrder || 0);
                if (!item) {
                    this.finish(session, 'error', '当前题目解析失败');
                    return;
                }
                item.order ||= currentOrder;
                if (!(item.order > 0)) {
                    this.finish(session, 'error', '无法识别当前题号，已停止以避免重复采集');
                    return;
                }

                if (!item.answer) {
                    for (let wait = 0; wait < 10; wait += 1) {
                        await sleep(250);
                        item = this.adapter.parseQuestion(this.adapter.getQuestionNodes()[0], item.order) || item;
                        if (item.answer) break;
                    }
                }

                const settings = this.settingsStore.load();
                if (!item.answer && settings.autoRevealAnswer) {
                    const reveal = this.adapter.findShowAnswer();
                    const attempts = Number(session.revealAttempts[item.order] || 0);
                    if (reveal && attempts < APP.maxRevealAttempts) {
                        session.revealAttempts[item.order] = attempts + 1;
                        session.phase = 'revealing';
                        session.pendingAnswerOrder = item.order;
                        this.ui.setStatus(`第 ${item.order} 题未显示答案，正在点击“显示答案”…`, 'active');
                        this.navigate(reveal, session, `显示答案-${item.order}`);
                        return;
                    }
                }

                if (!item.answer && session.phase === 'revealing' && Number(session.pendingAnswerOrder) === Number(item.order)) {
                    for (let wait = 0; wait < 15; wait += 1) {
                        await sleep(250);
                        item = this.adapter.parseQuestion(this.adapter.getQuestionNodes()[0], item.order) || item;
                        if (item.answer) break;
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

                const next = this.adapter.findNavigation('下一题');
                if (!next) {
                    this.finish(session, 'completed');
                    return;
                }
                this.navigate(next, session, `下一题-${item.order + 1}`);
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
                this.resumeTimer = setTimeout(() => this.resume(), 1100);
            }
        }
    }

    const adapter = new ChaoxingAdapter();
    const settingsStore = new SettingsStore();
    const store = new SessionStore(adapter);
    const ui = new AppUI(store, settingsStore);
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

    function mount() {
        if (!adapter.hasQuestions()) return false;
        ui.mount();
        ui.on('start', () => collector.start());
        ui.on('scan', () => collector.scanCurrentPage());
        ui.on('pause', () => collector.pause());
        ui.on('clear', () => collector.clear());
        ui.on('excel', () => handleExport('exportExcel'));
        ui.on('markdown', () => handleExport('exportMarkdown'));
        ui.on('json', () => handleExport('exportJson'));
        ui.on('settings', () => ui.refresh());
        collector.autoResume();
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

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            const session = store.load();
            if (session?.active) {
                event.preventDefault();
                collector.pause('用户按 Esc 暂停采集');
            }
        }
    }, true);

    window.addEventListener('pageshow', () => collector.autoResume());

    initialize();
})();
