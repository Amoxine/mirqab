// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import arDocs from '@/messages/ar/docs.json';
import enDocs from '@/messages/en/docs.json';
import { Mermaid } from './mermaid';

const { initialize, renderDiagram } = vi.hoisted(() => ({ initialize: vi.fn(), renderDiagram: vi.fn() }));
vi.mock('mermaid', () => ({ default: { initialize, render: renderDiagram } }));
vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }));

afterEach(cleanup);
beforeEach(() => {
  initialize.mockReset();
  renderDiagram.mockReset();
});

const CHART = 'flowchart LR\n  A[Create an API] --> B["Activate it"]\n  B --> C[Create a key]\n  A --> B';

function renderChart(locale: 'en' | 'ar', chart = CHART) {
  const messages = { docs: locale === 'ar' ? arDocs : enDocs };
  return render(
    <NextIntlClientProvider locale={locale} messages={messages}>
      <Mermaid chart={chart} />
    </NextIntlClientProvider>,
  );
}

describe('Mermaid', () => {
  it('holds the diagram\'s room while it loads, then shows it with its steps as the accessible name', async () => {
    renderDiagram.mockResolvedValue({ svg: '<svg data-testid="drawn"></svg>' });
    renderChart('en');

    const figure = screen.getByRole('img', { name: 'Diagram: Create an API, Activate it, Create a key' });
    expect(figure.className).toContain('min-h-24');

    expect(await screen.findByTestId('drawn')).toBeDefined();
    expect(figure.className).not.toContain('min-h-24');
    expect(renderDiagram).toHaveBeenCalledOnce();
  });

  it('names the diagram in the reader\'s language and list style', async () => {
    renderDiagram.mockResolvedValue({ svg: '<svg data-testid="drawn"></svg>' });
    renderChart('ar', 'flowchart RL\n  A["إنشاء مفتاح"] --> B["استدعاء البوابة"]');

    await screen.findByTestId('drawn');
    // Arabic joins the last step with "و" ("and"), as the language's own list style does.
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe(
      arDocs.shell.diagram.replace('{steps}', 'إنشاء مفتاح واستدعاء البوابة'),
    );
  });

  it('shows the diagram\'s text and logs the error when it cannot be drawn', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const cause = new Error('Parse error on line 2');
    renderDiagram.mockRejectedValue(cause);
    renderChart('en', 'flowchart LR\n  A[--> B');

    await waitFor(() => {
      expect(screen.queryByRole('img')).toBeNull();
    });
    expect(document.querySelector('pre')?.textContent).toBe('flowchart LR\n  A[--> B');
    expect(error).toHaveBeenCalledWith('Rendering a documentation diagram failed', cause);
    error.mockRestore();
  });
});
