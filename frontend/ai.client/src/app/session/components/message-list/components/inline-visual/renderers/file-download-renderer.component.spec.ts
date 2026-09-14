import { ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { ConfigService } from '../../../../../../services/config.service';
import { FileDownloadRendererComponent } from './file-download-renderer.component';

describe('FileDownloadRendererComponent', () => {
  let fixture: ComponentFixture<FileDownloadRendererComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [FileDownloadRendererComponent],
    }).compileComponents();

    TestBed.inject(ConfigService).appApiUrl.set('/api');
    fixture = TestBed.createComponent(FileDownloadRendererComponent);
  });

  function render(payload: unknown): HTMLAnchorElement | null {
    fixture.componentRef.setInput('payload', payload);
    fixture.detectChanges();
    return fixture.nativeElement.querySelector('a');
  }

  it('links an upload_id payload at the durable download route', () => {
    const anchor = render({
      filename: 'plan.docx',
      upload_id: '1a098460e41_ba6e8f342f1744e2',
      size_kb: '51.0 KB',
    });

    expect(anchor?.getAttribute('href')).toBe(
      '/api/files/1a098460e41_ba6e8f342f1744e2/download',
    );
    expect(fixture.nativeElement.textContent).toContain('plan.docx');
    expect(fixture.nativeElement.textContent).toContain('51.0 KB');
  });

  it('routes a legacy presigned download_url through the same durable route', () => {
    // Cards persisted before the backend stopped emitting signed URLs carry a
    // download_url whose signature expired an hour after it was written.
    const anchor = render({
      filename: 'plan.docx',
      download_url:
        'https://bucket.s3.us-west-2.amazonaws.com/user-files/u1/s1/up9/plan.docx' +
        '?X-Amz-Signature=deadbeef',
    });

    expect(anchor?.getAttribute('href')).toBe('/api/files/up9/download');
  });

  it('renders nothing when neither an upload id nor a usable URL is present', () => {
    expect(render({ filename: 'plan.docx' })).toBeNull();
    expect(render({ upload_id: 'up1' })).toBeNull();
    expect(render(null)).toBeNull();
  });
});
