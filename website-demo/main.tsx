import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '../src/styles.css';
import { App } from '../src/App';
import { installDemo, demoEvent } from './state';
import { installGuide } from './guide';
import './style.css';

class DemoWorkspace extends React.Component<Record<string, never>, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() { return { failed: true }; }

  componentDidCatch() { demoEvent('workspace-error'); }

  render() {
    if (this.state.failed) {
      return (
        <main className="demo-load-error">
          <h1>This screen couldn’t load.</h1>
          <button className="button primary" onClick={() => location.reload()}>Reload example</button>
        </main>
      );
    }
    return <App />;
  }
}

installDemo();
createRoot(document.getElementById('root')!).render(<><DemoWorkspace /><div className="website-demo-label">Interactive example · no live agents or local access</div></>);
installGuide();

document.addEventListener('click', (event) => {
  const target = (event.target as Element).closest<HTMLElement>('.work-card,.detail-tabs button');
  if (target?.classList.contains('work-card')) demoEvent('story-opened', { storyId: target.getAttribute('aria-label')?.split(':')[0] });
  else if (target) demoEvent('tab-changed', { tab: target.textContent?.trim().toLowerCase() });
});
