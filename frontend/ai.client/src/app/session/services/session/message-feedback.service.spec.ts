import { TestBed } from '@angular/core/testing';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { signal } from '@angular/core';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConfigService } from '../../../services/config.service';
import { Message } from '../models/message.model';
import {
  MessageFeedbackService,
  parseMessageRef,
  readPersistedFeedback,
} from './message-feedback.service';

function message(id: string, metadata: Record<string, unknown> | null = null): Message {
  return { id, role: 'assistant', content: [{ type: 'text', text: 'hi' }], metadata };
}

describe('message-feedback helpers', () => {
  it('parseMessageRef splits on the LAST dash so dashed session ids survive', () => {
    expect(parseMessageRef('msg-abc-def-7')).toEqual({ sessionId: 'abc-def', index: 7 });
    expect(parseMessageRef('msg-s-0')).toEqual({ sessionId: 's', index: 0 });
    expect(parseMessageRef('placeholder')).toBeNull();
    expect(parseMessageRef('msg-s-x')).toBeNull();
    expect(parseMessageRef('msg--1')).toBeNull();
  });

  it('readPersistedFeedback accepts only ±1 and known reason codes', () => {
    expect(readPersistedFeedback(message('m'))).toBeNull();
    expect(readPersistedFeedback(message('m', { feedback: { value: 2 } }))).toBeNull();
    expect(readPersistedFeedback(message('m', { feedback: { value: -1, reason: 'wrong', updatedAt: 't' } }))).toEqual({
      value: -1,
      reason: 'wrong',
      updatedAt: 't',
    });
    // An unknown reason is dropped rather than rendered — it cannot be a chip.
    expect(readPersistedFeedback(message('m', { feedback: { value: 1, reason: 'free text' } }))?.reason).toBeUndefined();
  });
});

describe('MessageFeedbackService', () => {
  let service: MessageFeedbackService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: ConfigService, useValue: { appApiUrl: signal('http://api.test/') } },
      ],
    });
    service = TestBed.inject(MessageFeedbackService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('prefers what the server sent with the message until a click overrides it', () => {
    const m = message('msg-s-3', { feedback: { value: 1, updatedAt: 't' } });
    expect(service.feedbackFor(m)?.value).toBe(1);
  });

  it('PUTs a content-free body to the message index and keeps the optimistic value', async () => {
    const m = message('msg-s-3');
    const done = service.setFeedback(m, -1, 'slow');
    expect(service.feedbackFor(m)?.value).toBe(-1);

    const req = http.expectOne('http://api.test/sessions/s/messages/3/feedback');
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ value: -1, reason: 'slow' });
    req.flush({ value: -1, reason: 'slow', updatedAt: '2026-09-16T00:00:00Z' });
    await done;
    expect(service.feedbackFor(m)).toEqual({ value: -1, reason: 'slow', updatedAt: '2026-09-16T00:00:00Z' });
  });

  it('rolls back to the last confirmed value when the write fails', async () => {
    const m = message('msg-s-3', { feedback: { value: 1, updatedAt: 't' } });
    const done = service.setFeedback(m, -1);
    expect(service.feedbackFor(m)?.value).toBe(-1);
    http.expectOne('http://api.test/sessions/s/messages/3/feedback').flush('nope', { status: 500, statusText: 'err' });
    await done;
    expect(service.feedbackFor(m)?.value).toBe(1);
    expect(service.unavailable()).toBe(false);
  });

  it('DELETE withdraws the thumb', async () => {
    const m = message('msg-s-3', { feedback: { value: 1, updatedAt: 't' } });
    const done = service.clearFeedback(m);
    expect(service.feedbackFor(m)).toBeNull();
    const req = http.expectOne('http://api.test/sessions/s/messages/3/feedback');
    expect(req.request.method).toBe('DELETE');
    req.flush(null, { status: 204, statusText: 'No Content' });
    await done;
    expect(service.feedbackFor(m)).toBeNull();
  });

  it('marks the surface unavailable only on the kill-switch 404', async () => {
    const m = message('msg-s-3');
    let done = service.setFeedback(m, 1);
    http.expectOne('http://api.test/sessions/s/messages/3/feedback').flush({ detail: 'Session not found: s' }, { status: 404, statusText: 'nf' });
    await done;
    expect(service.unavailable()).toBe(false);

    done = service.setFeedback(m, 1);
    http.expectOne('http://api.test/sessions/s/messages/3/feedback').flush({ detail: 'Not found' }, { status: 404, statusText: 'nf' });
    await done;
    expect(service.unavailable()).toBe(true);
  });

  it('ignores messages without a server index', async () => {
    await service.setFeedback(message('placeholder'), 1);
    http.expectNone(() => true);
  });
});
