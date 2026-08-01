import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import NimbusCompanion from './NimbusCompanion';

describe('NimbusCompanion surface', () => {
  it('renders the actor as an explicitly transparent, reset button surface', () => {
    const markup = renderToStaticMarkup(<NimbusCompanion state="error" />);

    expect(markup).toContain('Needs attention. Draggable Nimbus companion');
    expect(markup).toContain('appearance-none border-0 bg-transparent p-0');
    expect(markup).toContain('/mascot/nimbus-companion.png');
  });
});
