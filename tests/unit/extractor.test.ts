import { describe, it, expect } from 'vitest';
import { RecordingExtractor } from '../../src/extractor/RecordingExtractor.js';

describe('RecordingExtractor Unit Tests', () => {
  describe('parseDuration', () => {
    it('handles HH:MM:SS format', () => {
      expect(RecordingExtractor.parseDuration('1:23:45')).toBe(5025);
    });

    it('handles padded 01:23:45 format', () => {
      expect(RecordingExtractor.parseDuration('01:23:45')).toBe(5025);
    });

    it('handles MM:SS format', () => {
      expect(RecordingExtractor.parseDuration('23:45')).toBe(1425);
    });

    it('handles "1h 23m 45s"', () => {
      expect(RecordingExtractor.parseDuration('1h 23m 45s')).toBe(5025);
    });

    it('handles "1h 23m"', () => {
      expect(RecordingExtractor.parseDuration('1h 23m')).toBe(4980);
    });

    it('handles "23m 45s"', () => {
      expect(RecordingExtractor.parseDuration('23m 45s')).toBe(1425);
    });

    it('handles "45s"', () => {
      expect(RecordingExtractor.parseDuration('45s')).toBe(45);
    });

    it('handles Spanish "1 hora 30 min"', () => {
      expect(RecordingExtractor.parseDuration('1 hora 30 min')).toBe(5400);
    });

    it('handles Spanish "45 seg"', () => {
      expect(RecordingExtractor.parseDuration('45 seg')).toBe(45);
    });

    it('handles missing/empty duration string by returning 0', () => {
      expect(RecordingExtractor.parseDuration('')).toBe(0);
      expect(RecordingExtractor.parseDuration('  ')).toBe(0);
    });

    it('handles 0:00:00 and 0:00', () => {
      expect(RecordingExtractor.parseDuration('0:00:00')).toBe(0);
      expect(RecordingExtractor.parseDuration('0:00')).toBe(0);
    });

    it('returns 0 for invalid string', () => {
      expect(RecordingExtractor.parseDuration('no-duration-here')).toBe(0);
    });
  });

  describe('normalizeDate', () => {
    it('normalizes Spanish date in DD/MM/YYYY HH:mm format', () => {
      const result = RecordingExtractor.normalizeDate('25/10/2026 18:30');
      const d = new Date(result);
      expect(d.getFullYear()).toBe(2026);
      expect(d.getMonth()).toBe(9); // October
      expect(d.getDate()).toBe(25);
      expect(d.getHours()).toBe(18);
      expect(d.getMinutes()).toBe(30);
    });

    it('normalizes Spanish date in DD/MM/YYYY format without time', () => {
      const result = RecordingExtractor.normalizeDate('05/10/2026');
      const d = new Date(result);
      expect(d.getFullYear()).toBe(2026);
      expect(d.getMonth()).toBe(9); // October
      expect(d.getDate()).toBe(5);
    });

    it('normalizes Spanish date with hyphens DD-MM-YYYY HH:mm', () => {
      const result = RecordingExtractor.normalizeDate('15-09-2026 09:15');
      const d = new Date(result);
      expect(d.getFullYear()).toBe(2026);
      expect(d.getMonth()).toBe(8); // September
      expect(d.getDate()).toBe(15);
      expect(d.getHours()).toBe(9);
      expect(d.getMinutes()).toBe(15);
    });

    it('normalizes Spanish textual date "5 de octubre de 2026"', () => {
      const result = RecordingExtractor.normalizeDate('5 de octubre de 2026');
      const d = new Date(result);
      expect(d.getFullYear()).toBe(2026);
      expect(d.getMonth()).toBe(9); // October
      expect(d.getDate()).toBe(5);
    });

    it('normalizes "Hoy" and "Today"', () => {
      const resHoy = RecordingExtractor.normalizeDate('Hoy');
      const resToday = RecordingExtractor.normalizeDate('Today');
      const todayIso = new Date().toISOString().split('T')[0];
      expect(resHoy.startsWith(todayIso!)).toBe(true);
      expect(resToday.startsWith(todayIso!)).toBe(true);
    });

    it('normalizes "Ayer" and "Yesterday"', () => {
      const resAyer = RecordingExtractor.normalizeDate('Ayer');
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yIso = yesterday.toISOString().split('T')[0];
      expect(resAyer.startsWith(yIso!)).toBe(true);
    });

    it('normalizes "YYYY-MM-DD" format', () => {
      const result = RecordingExtractor.normalizeDate('2026-10-05');
      expect(new Date(result).toISOString().startsWith('2026-10-05')).toBe(true);
    });

    it('falls back to current date for empty or invalid string', () => {
      const resEmpty = RecordingExtractor.normalizeDate('');
      const resInvalid = RecordingExtractor.normalizeDate('not-a-date');
      const todayIso = new Date().toISOString().split('T')[0];
      expect(resEmpty.startsWith(todayIso!)).toBe(true);
      expect(resInvalid.startsWith(todayIso!)).toBe(true);
    });
  });

  describe('generateCollabId & Compound Key', () => {
    it('uses stable UI id when available', () => {
      const id1 = RecordingExtractor.generateCollabId({
        uiId: 'rec-uuid-12345',
        title: 'Clase 1',
        createdAt: '2026-10-01T10:00:00Z',
        durationSeconds: 3600,
      });
      const id2 = RecordingExtractor.generateCollabId({
        uiId: 'rec-uuid-12345',
        title: 'Titulo cambiado',
        createdAt: '2026-10-02T10:00:00Z',
        durationSeconds: 1800,
      });
      // Should remain identical because uiId is preferred
      expect(id1).toBe(id2);
      expect(id1).toMatch(/^[0-9a-f]{16}$/i);
    });

    it('uses playbackUrl when uiId is not provided', () => {
      const id1 = RecordingExtractor.generateCollabId({
        playbackUrl: 'https://collab2.bbcollab.com/playback/session-abc',
        title: 'Clase 1',
        createdAt: '2026-10-01T10:00:00Z',
        durationSeconds: 3600,
      });
      const id2 = RecordingExtractor.generateCollabId({
        playbackUrl: 'https://collab2.bbcollab.com/playback/session-abc',
        title: 'Clase 1 - Renombrada',
        createdAt: '2026-10-01T10:00:00Z',
        durationSeconds: 3600,
      });
      expect(id1).toBe(id2);
    });

    it('differentiates duplicate titles with different dates using compound key', () => {
      const idA = RecordingExtractor.generateCollabId({
        courseIdentifier: 'curso-viu-matematicas',
        title: 'Clase Magistral Tema 1',
        createdAt: '2026-10-01T10:00:00.000Z',
        durationSeconds: 3600,
      });
      const idB = RecordingExtractor.generateCollabId({
        courseIdentifier: 'curso-viu-matematicas',
        title: 'Clase Magistral Tema 1', // Same title!
        createdAt: '2026-10-08T10:00:00.000Z', // Different date
        durationSeconds: 3600,
      });

      expect(idA).not.toBe(idB);
      expect(idA).toMatch(/^[0-9a-f]{16}$/i);
      expect(idB).toMatch(/^[0-9a-f]{16}$/i);
    });

    it('differentiates duplicate titles and dates with different courses or durations', () => {
      const idCourse1 = RecordingExtractor.generateCollabId({
        courseIdentifier: 'course-A',
        title: 'Repaso Examen',
        createdAt: '2026-10-15T18:00:00.000Z',
        durationSeconds: 3600,
      });
      const idCourse2 = RecordingExtractor.generateCollabId({
        courseIdentifier: 'course-B',
        title: 'Repaso Examen',
        createdAt: '2026-10-15T18:00:00.000Z',
        durationSeconds: 3600,
      });

      expect(idCourse1).not.toBe(idCourse2);
    });
  });
});
