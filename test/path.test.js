import { expect } from 'chai';
import { isWindows } from '../src/isWindows.js';
import { resolve, posix, win32 } from '../src/index.js';

// Couple of smoke tests that are ran in Node LTS both windows & linux
// Would be nice to add more tests

describe('path', () => {
  describe('should do basic path operations properly, conditionally posix & win32', () => {
    it('applies to resolve', () => {
      const resolved = resolve('foo/bar');

      if (isWindows()) {
        expect(resolved.endsWith('foo\\bar')).to.be.true;
        // match D:\foo\bar -> optional drive letter+colon, backslash
        expect(resolved.match(/^([a-zA-Z]:)?\\/g)?.length).to.equal(1);
      } else {
        expect(resolved.endsWith('foo/bar')).to.be.true;
        expect(resolved.startsWith('/')).to.be.true;
      }
    });
  });

  describe('should do basic path operations properly, allow forcing win32', () => {
    it('applies to resolve', () => {
      const resolved = win32.resolve('foo/bar');
      expect(resolved.endsWith('foo\\bar')).to.be.true;
      // match D:\foo\bar -> optional drive letter+colon, backslash
      expect(resolved.match(/^([a-zA-Z]:)?\\/g)?.length).to.equal(1);
    });
  });

  describe('should do basic path operations properly, allow forcing posix', () => {
    it('applies to resolve', () => {
      const resolved = posix.resolve('foo/bar');
      expect(resolved.endsWith('foo/bar')).to.be.true;
      expect(resolved.startsWith('/')).to.be.true;
    });
  });
});
