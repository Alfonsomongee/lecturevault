import { describe, it, expect } from 'vitest';
import { PageNavigator } from '../../src/navigator/PageNavigator.js';
import pino from 'pino';

describe('PageNavigator Strict Host Allowlist', () => {
  const silentLogger = pino({ level: 'silent' });
  const mockPage: any = {
    url: () => 'https://campusvirtual.universidad.es/ultra/courses',
    $: async () => null,
    goto: async () => {},
  };

  it('allows exact LMS host from baseUrl', () => {
    const nav = new PageNavigator(
      mockPage,
      {
        lmsBaseUrl: 'https://campusvirtual.universidad.es',
        collabRecordingsPath: '/ultra/courses',
        timeoutMs: 5000,
        screenshotDir: './data/screenshots',
      },
      silentLogger
    );

    expect(nav.isAllowedUrl('https://campusvirtual.universidad.es/ultra/courses')).toBe(true);
    expect(nav.isAllowedUrl('https://campusvirtual.universidad.es/some/path?param=1')).toBe(true);
  });

  it('allows external Collab2 host when explicitly configured', () => {
    const nav = new PageNavigator(
      mockPage,
      {
        lmsBaseUrl: 'https://campusvirtual.universidad.es',
        collabRecordingsPath: '/ultra/courses',
        allowedHosts: [
          'campusvirtual.universidad.es',
          'collab2.bbcollab.com',
          'eu.bbcollab.com',
        ],
        timeoutMs: 5000,
        screenshotDir: './data/screenshots',
      },
      silentLogger
    );

    expect(nav.isAllowedUrl('https://collab2.bbcollab.com/recordings/view')).toBe(true);
    expect(nav.isAllowedUrl('https://eu.bbcollab.com/collab/ui')).toBe(true);
  });

  it('strictly rejects unknown or unallowed external hosts', () => {
    const nav = new PageNavigator(
      mockPage,
      {
        lmsBaseUrl: 'https://campusvirtual.universidad.es',
        collabRecordingsPath: '/ultra/courses',
        allowedHosts: ['campusvirtual.universidad.es', 'collab2.bbcollab.com'],
        timeoutMs: 5000,
        screenshotDir: './data/screenshots',
      },
      silentLogger
    );

    expect(nav.isAllowedUrl('https://malicious-site.com/fake')).toBe(false);
    expect(nav.isAllowedUrl('https://another-uni.blackboard.com')).toBe(false);
    expect(nav.isAllowedUrl('https://google.com')).toBe(false);
  });

  it('does NOT allow arbitrary subdomains via wildcard or suffix matching if not in allowlist', () => {
    const nav = new PageNavigator(
      mockPage,
      {
        lmsBaseUrl: 'https://campusvirtual.universidad.es',
        collabRecordingsPath: '/ultra/courses',
        allowedHosts: ['campusvirtual.universidad.es'],
        timeoutMs: 5000,
        screenshotDir: './data/screenshots',
      },
      silentLogger
    );

    // Should NOT allow attacker site ending in domain or arbitrary unlisted subdomain
    expect(nav.isAllowedUrl('https://fakecampusvirtual.universidad.es.attacker.com')).toBe(false);
    expect(nav.isAllowedUrl('https://other.universidad.es')).toBe(false);
  });
});
