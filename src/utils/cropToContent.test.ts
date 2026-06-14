import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isCropToContentSupported,
  isCroppableTrack,
  cropToContentArea,
  removeCrop,
} from './cropToContent';

describe('cropToContent utility', () => {
  describe('isCropToContentSupported', () => {
    afterEach(() => {
      // Clean up any global CropTarget mock
      delete (globalThis as any).CropTarget;
    });

    it('returns false when CropTarget is not defined', () => {
      delete (globalThis as any).CropTarget;
      expect(isCropToContentSupported()).toBe(false);
    });

    it('returns true when CropTarget is defined', () => {
      (globalThis as any).CropTarget = { fromElement: vi.fn() };
      expect(isCropToContentSupported()).toBe(true);
    });
  });

  describe('isCroppableTrack', () => {
    it('returns false for a track without cropTo', () => {
      const track = { kind: 'video', readyState: 'live' } as unknown as MediaStreamTrack;
      expect(isCroppableTrack(track)).toBe(false);
    });

    it('returns true for a track with cropTo function', () => {
      const track = {
        kind: 'video',
        readyState: 'live',
        cropTo: vi.fn(),
      } as unknown as MediaStreamTrack;
      expect(isCroppableTrack(track)).toBe(true);
    });
  });

  describe('cropToContentArea', () => {
    afterEach(() => {
      delete (globalThis as any).CropTarget;
    });

    it('throws when CropTarget API is not supported', async () => {
      delete (globalThis as any).CropTarget;
      const track = { kind: 'video' } as unknown as MediaStreamTrack;
      const element = document.createElement('div');

      await expect(cropToContentArea(track, element)).rejects.toThrow(
        /Region Capture API.*not supported/,
      );
    });

    it('throws when the track does not support cropTo', async () => {
      (globalThis as any).CropTarget = { fromElement: vi.fn() };
      const track = { kind: 'video' } as unknown as MediaStreamTrack;
      const element = document.createElement('div');

      await expect(cropToContentArea(track, element)).rejects.toThrow(
        /does not support cropTo/,
      );
    });

    it('calls CropTarget.fromElement and track.cropTo on success', async () => {
      const mockCropTarget = { __brand: 'CropTarget' as const };
      const mockFromElement = vi.fn().mockResolvedValue(mockCropTarget);
      (globalThis as any).CropTarget = { fromElement: mockFromElement };

      const mockCropTo = vi.fn().mockResolvedValue(undefined);
      const track = {
        kind: 'video',
        readyState: 'live',
        cropTo: mockCropTo,
      } as unknown as MediaStreamTrack;
      const element = document.createElement('div');

      await cropToContentArea(track, element);

      expect(mockFromElement).toHaveBeenCalledWith(element);
      expect(mockCropTo).toHaveBeenCalledWith(mockCropTarget);
    });

    it('propagates errors from CropTarget.fromElement', async () => {
      const mockFromElement = vi.fn().mockRejectedValue(new DOMException('Not in captured tab'));
      (globalThis as any).CropTarget = { fromElement: mockFromElement };

      const track = {
        kind: 'video',
        cropTo: vi.fn(),
      } as unknown as MediaStreamTrack;
      const element = document.createElement('div');

      await expect(cropToContentArea(track, element)).rejects.toThrow('Not in captured tab');
    });

    it('propagates errors from track.cropTo', async () => {
      const mockCropTarget = { __brand: 'CropTarget' as const };
      (globalThis as any).CropTarget = {
        fromElement: vi.fn().mockResolvedValue(mockCropTarget),
      };

      const mockCropTo = vi.fn().mockRejectedValue(new DOMException('Track ended'));
      const track = {
        kind: 'video',
        cropTo: mockCropTo,
      } as unknown as MediaStreamTrack;
      const element = document.createElement('div');

      await expect(cropToContentArea(track, element)).rejects.toThrow('Track ended');
    });
  });

  describe('removeCrop', () => {
    it('throws when the track does not support cropTo', async () => {
      const track = { kind: 'video' } as unknown as MediaStreamTrack;

      await expect(removeCrop(track)).rejects.toThrow(/does not support cropTo/);
    });

    it('calls track.cropTo(null) to remove the crop', async () => {
      const mockCropTo = vi.fn().mockResolvedValue(undefined);
      const track = {
        kind: 'video',
        cropTo: mockCropTo,
      } as unknown as MediaStreamTrack;

      await removeCrop(track);

      expect(mockCropTo).toHaveBeenCalledWith(null);
    });

    it('propagates errors from track.cropTo(null)', async () => {
      const mockCropTo = vi.fn().mockRejectedValue(new DOMException('Track already ended'));
      const track = {
        kind: 'video',
        cropTo: mockCropTo,
      } as unknown as MediaStreamTrack;

      await expect(removeCrop(track)).rejects.toThrow('Track already ended');
    });
  });
});
