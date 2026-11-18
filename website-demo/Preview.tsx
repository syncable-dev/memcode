import { ArrowLeft, FileText, ShieldCheck } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import TextFile from '../artifact-viewer/text';
import type { Artifact } from '../src/shared';
import type { FileReference } from '../src/file-reference';
import { designImage, report } from './state';
import { DemoPage } from './Browser';
import { menuSource, menuSourcePath } from './review';
import './source.css';

export function ArtifactPreview({ artifact, file, onBack }: { artifact?: Artifact; file?: FileReference; onBack: () => void }) {
  const name = artifact?.name ?? file?.name ?? 'implementation-report.md';
  const source = file?.path === menuSourcePath;
  const format = source ? 'TypeScript' : name.endsWith('.md') ? 'Markdown' : name.endsWith('.svg') ? 'Image' : 'Interactive HTML';
  return (
    <section className="artifact-preview" aria-label="Artifact preview">
      <header className="artifact-preview-header">
        <button className="text-button" onClick={onBack}><ArrowLeft size={13}/>{file ? 'Conversation' : 'All artifacts'}</button>
        <span className="artifact-preview-divider"/><FileText size={16}/>
        <div><strong>{name}</strong><small>{source ? file.relativePath : 'Saved example output'}</small></div>
        <span className="artifact-format-tag">{format}</span>
      </header>
      <div className="artifact-preview-content demo-document-content">
        {source ? <TextFile bytes={menuSource} name={name} line={file.line}/> :
          name.endsWith('.svg') ? <img src={designImage} alt="Lumen example design output"/> :
          name.endsWith('.html') ? <DemoPage/> :
          <article className="artifact-document demo-report"><ReactMarkdown remarkPlugins={[remarkGfm]}>{report}</ReactMarkdown></article>}
      </div>
      <footer className="artifact-preview-footer"><ShieldCheck size={11}/>Saved output · example content</footer>
    </section>
  );
}
