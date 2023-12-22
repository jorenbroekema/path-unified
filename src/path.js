/**
 * Essentially an ESM copy of https://github.com/nodejs/node/blob/v21.5.0/lib/path.js
 * Changes:
 * - Convert to ESM -> make sure everything is importable as old, and tree-shakeable
 * - Hardcopy Node internal/constants, since node does not expose them
 * - Refactor primordials usage into just regular methods on String/Function prototype,
 *   since node does not expose primordials
 *   https://github.com/nodejs/node/pull/40733 was unfortunately closed: "not a common ask"
 * - Hardcopy 2 validators from internal/validators, since node does not expose them
 * - Use a browser-compatible isWindows check
 * - Shim process.cwd() for browser (should return '/')
 */

import {
  CHAR_UPPERCASE_A,
  CHAR_LOWERCASE_A,
  CHAR_UPPERCASE_Z,
  CHAR_LOWERCASE_Z,
  CHAR_DOT,
  CHAR_FORWARD_SLASH,
  CHAR_BACKWARD_SLASH,
  CHAR_COLON,
  CHAR_QUESTION_MARK,
} from './constants.js';
import { isWindows } from './isWindows.js';
import { validateObject, validateString } from './validators.js';

// shim process.cwd for browser
if (typeof window === 'object') {
  // careful not to remove other process methods shims that might be added by other modules
  if (!window.process) {
    // @ts-expect-error shimming Node process
    window.process = {};
  }
  // In browser context, the "current working directory" is usually just root '/'
  window.process.cwd = () => '/';
}

// browser-compatible windows check
const platformIsWin32 = isWindows();

/**
 * @param {number} code
 * @returns
 */
function isPathSeparator(code) {
  return code === CHAR_FORWARD_SLASH || code === CHAR_BACKWARD_SLASH;
}

/**
 * @param {number} code
 * @returns
 */
function isPosixPathSeparator(code) {
  return code === CHAR_FORWARD_SLASH;
}

/**
 * @param {number} code
 * @returns
 */
function isWindowsDeviceRoot(code) {
  return (
    (code >= CHAR_UPPERCASE_A && code <= CHAR_UPPERCASE_Z) ||
    (code >= CHAR_LOWERCASE_A && code <= CHAR_LOWERCASE_Z)
  );
}

/**
 * Resolves . and .. elements in a path with directory names
 * @param {string} path
 * @param {boolean} allowAboveRoot
 * @param {string} separator
 * @param {(num: number) => boolean} isPathSeparator
 * @returns
 */
function normalizeString(path, allowAboveRoot, separator, isPathSeparator) {
  let res = '';
  let lastSegmentLength = 0;
  let lastSlash = -1;
  let dots = 0;
  let code = 0;
  for (let i = 0; i <= path.length; ++i) {
    if (i < path.length) code = path.charCodeAt(i);
    else if (isPathSeparator(code)) break;
    else code = CHAR_FORWARD_SLASH;

    if (isPathSeparator(code)) {
      if (lastSlash === i - 1 || dots === 1) {
        // NOOP
      } else if (dots === 2) {
        if (
          res.length < 2 ||
          lastSegmentLength !== 2 ||
          res.charCodeAt(res.length - 1) !== CHAR_DOT ||
          res.charCodeAt(res.length - 2) !== CHAR_DOT
        ) {
          if (res.length > 2) {
            const lastSlashIndex = res.lastIndexOf(separator);
            if (lastSlashIndex === -1) {
              res = '';
              lastSegmentLength = 0;
            } else {
              res = res.slice(0, lastSlashIndex);
              lastSegmentLength = res.length - 1 - res.lastIndexOf(separator);
            }
            lastSlash = i;
            dots = 0;
            continue;
          } else if (res.length !== 0) {
            res = '';
            lastSegmentLength = 0;
            lastSlash = i;
            dots = 0;
            continue;
          }
        }
        if (allowAboveRoot) {
          res += res.length > 0 ? `${separator}..` : '..';
          lastSegmentLength = 2;
        }
      } else {
        if (res.length > 0) res += `${separator}${path.slice(lastSlash + 1, i)}`;
        else res = path.slice(lastSlash + 1, i);
        lastSegmentLength = i - lastSlash - 1;
      }
      lastSlash = i;
      dots = 0;
    } else if (code === CHAR_DOT && dots !== -1) {
      ++dots;
    } else {
      dots = -1;
    }
  }
  return res;
}

/**
 * @param {string} [ext]
 * @returns
 */
function formatExt(ext) {
  return ext ? `${ext[0] === '.' ? '' : '.'}${ext}` : '';
}

/**
 * @param {string} sep
 * @param {{
 *  dir?: string;
 *  root?: string;
 *  base?: string;
 *  name?: string;
 *  ext?: string;
 *  }} pathObject
 * @returns {string}
 */
function _format(sep, pathObject) {
  validateObject(pathObject, 'pathObject');
  const dir = pathObject.dir || pathObject.root;
  const base = pathObject.base || `${pathObject.name || ''}${formatExt(pathObject.ext)}`;
  if (!dir) {
    return base;
  }
  return dir === pathObject.root ? `${dir}${base}` : `${dir}${sep}${base}`;
}

/**
 * path.resolve([from ...], to)
 * @param {...string} args
 * @returns {string}
 */
function winResolve(...args) {
  let resolvedDevice = '';
  let resolvedTail = '';
  let resolvedAbsolute = false;

  for (let i = args.length - 1; i >= -1; i--) {
    let path;
    if (i >= 0) {
      path = args[i];
      validateString(path, `paths[${i}]`);

      // Skip empty entries
      if (path.length === 0) {
        continue;
      }
    } else if (resolvedDevice.length === 0) {
      path = process.cwd();
    } else {
      // Windows has the concept of drive-specific current working
      // directories. If we've resolved a drive letter but not yet an
      // absolute path, get cwd for that drive, or the process cwd if
      // the drive cwd is not available. We're sure the device is not
      // a UNC path at this points, because UNC paths are always absolute.
      path = process?.env[`=${resolvedDevice}`] || process.cwd();

      // Verify that a cwd was found and that it actually points
      // to our drive. If not, default to the drive's root.
      if (
        path === undefined ||
        (path.slice(0, 2).toLowerCase() !== resolvedDevice.toLowerCase() &&
          path.charCodeAt(2) === CHAR_BACKWARD_SLASH)
      ) {
        path = `${resolvedDevice}\\`;
      }
    }

    const len = path.length;
    let rootEnd = 0;
    let device = '';
    let isAbsolute = false;
    const code = path.charCodeAt(0);

    // Try to match a root
    if (len === 1) {
      if (isPathSeparator(code)) {
        // `path` contains just a path separator
        rootEnd = 1;
        isAbsolute = true;
      }
    } else if (isPathSeparator(code)) {
      // Possible UNC root

      // If we started with a separator, we know we at least have an
      // absolute path of some kind (UNC or otherwise)
      isAbsolute = true;

      if (isPathSeparator(path.charCodeAt(1))) {
        // Matched double path separator at beginning
        let j = 2;
        let last = j;
        // Match 1 or more non-path separators
        while (j < len && !isPathSeparator(path.charCodeAt(j))) {
          j++;
        }
        if (j < len && j !== last) {
          const firstPart = path.slice(last, j);
          // Matched!
          last = j;
          // Match 1 or more path separators
          while (j < len && isPathSeparator(path.charCodeAt(j))) {
            j++;
          }
          if (j < len && j !== last) {
            // Matched!
            last = j;
            // Match 1 or more non-path separators
            while (j < len && !isPathSeparator(path.charCodeAt(j))) {
              j++;
            }
            if (j === len || j !== last) {
              // We matched a UNC root
              device = `\\\\${firstPart}\\${path.slice(last, j)}`;
              rootEnd = j;
            }
          }
        }
      } else {
        rootEnd = 1;
      }
    } else if (isWindowsDeviceRoot(code) && path.charCodeAt(1) === CHAR_COLON) {
      // Possible device root
      device = path.slice(0, 2);
      rootEnd = 2;
      if (len > 2 && isPathSeparator(path.charCodeAt(2))) {
        // Treat separator following drive name as an absolute path
        // indicator
        isAbsolute = true;
        rootEnd = 3;
      }
    }

    if (device.length > 0) {
      if (resolvedDevice.length > 0) {
        if (device.toLowerCase() !== resolvedDevice.toLowerCase())
          // This path points to another device so it is not applicable
          continue;
      } else {
        resolvedDevice = device;
      }
    }

    if (resolvedAbsolute) {
      if (resolvedDevice.length > 0) break;
    } else {
      resolvedTail = `${path.slice(rootEnd)}\\${resolvedTail}`;
      resolvedAbsolute = isAbsolute;
      if (isAbsolute && resolvedDevice.length > 0) {
        break;
      }
    }
  }

  // At this point the path should be resolved to a full absolute path,
  // but handle relative paths to be safe (might happen when process.cwd()
  // fails)

  // Normalize the tail path
  resolvedTail = normalizeString(resolvedTail, !resolvedAbsolute, '\\', isPathSeparator);

  return resolvedAbsolute
    ? `${resolvedDevice}\\${resolvedTail}`
    : `${resolvedDevice}${resolvedTail}` || '.';
}

/**
 * @param {string} path
 * @returns {string}
 */
function winNormalize(path) {
  validateString(path, 'path');
  const len = path.length;
  if (len === 0) return '.';
  let rootEnd = 0;
  let device;
  let isAbsolute = false;
  const code = path.charCodeAt(0);

  // Try to match a root
  if (len === 1) {
    // `path` contains just a single char, exit early to avoid
    // unnecessary work
    return isPosixPathSeparator(code) ? '\\' : path;
  }
  if (isPathSeparator(code)) {
    // Possible UNC root

    // If we started with a separator, we know we at least have an absolute
    // path of some kind (UNC or otherwise)
    isAbsolute = true;

    if (isPathSeparator(path.charCodeAt(1))) {
      // Matched double path separator at beginning
      let j = 2;
      let last = j;
      // Match 1 or more non-path separators
      while (j < len && !isPathSeparator(path.charCodeAt(j))) {
        j++;
      }
      if (j < len && j !== last) {
        const firstPart = path.slice(last, j);
        // Matched!
        last = j;
        // Match 1 or more path separators
        while (j < len && isPathSeparator(path.charCodeAt(j))) {
          j++;
        }
        if (j < len && j !== last) {
          // Matched!
          last = j;
          // Match 1 or more non-path separators
          while (j < len && !isPathSeparator(path.charCodeAt(j))) {
            j++;
          }
          if (j === len) {
            // We matched a UNC root only
            // Return the normalized version of the UNC root since there
            // is nothing left to process
            return `\\\\${firstPart}\\${path.slice(last)}\\`;
          }
          if (j !== last) {
            // We matched a UNC root with leftovers
            device = `\\\\${firstPart}\\${path.slice(last, j)}`;
            rootEnd = j;
          }
        }
      }
    } else {
      rootEnd = 1;
    }
  } else if (isWindowsDeviceRoot(code) && path.charCodeAt(1) === CHAR_COLON) {
    // Possible device root
    device = path.slice(0, 2);
    rootEnd = 2;
    if (len > 2 && isPathSeparator(path.charCodeAt(2))) {
      // Treat separator following drive name as an absolute path
      // indicator
      isAbsolute = true;
      rootEnd = 3;
    }
  }

  let tail =
    rootEnd < len ? normalizeString(path.slice(rootEnd), !isAbsolute, '\\', isPathSeparator) : '';
  if (tail.length === 0 && !isAbsolute) tail = '.';
  if (tail.length > 0 && isPathSeparator(path.charCodeAt(len - 1))) tail += '\\';
  if (device === undefined) {
    return isAbsolute ? `\\${tail}` : tail;
  }
  return isAbsolute ? `${device}\\${tail}` : `${device}${tail}`;
}

/**
 * @param {string} path
 * @returns {boolean}
 */
function winIsAbsolute(path) {
  validateString(path, 'path');
  const len = path.length;
  if (len === 0) return false;

  const code = path.charCodeAt(0);
  return (
    isPathSeparator(code) ||
    // Possible device root
    (len > 2 &&
      isWindowsDeviceRoot(code) &&
      path.charCodeAt(1) === CHAR_COLON &&
      isPathSeparator(path.charCodeAt(2)))
  );
}

/**
 * @param {...string} args
 * @returns {string}
 */
function winJoin(...args) {
  if (args.length === 0) return '.';

  let joined;
  let firstPart;
  for (let i = 0; i < args.length; ++i) {
    const arg = args[i];
    validateString(arg, 'path');
    if (arg.length > 0) {
      if (joined === undefined) joined = firstPart = arg;
      else joined += `\\${arg}`;
    }
  }

  if (joined === undefined) return '.';

  // Make sure that the joined path doesn't start with two slashes, because
  // normalize() will mistake it for a UNC path then.
  //
  // This step is skipped when it is very clear that the user actually
  // intended to point at a UNC path. This is assumed when the first
  // non-empty string arguments starts with exactly two slashes followed by
  // at least one more non-slash character.
  //
  // Note that for normalize() to treat a path as a UNC path it needs to
  // have at least 2 components, so we don't filter for that here.
  // This means that the user can use join to construct UNC paths from
  // a server name and a share name; for example:
  //   path.join('//server', 'share') -> '\\\\server\\share\\')
  let needsReplace = true;
  let slashCount = 0;
  if (firstPart !== undefined && isPathSeparator(firstPart.charCodeAt(0))) {
    ++slashCount;
    const firstLen = firstPart.length;
    if (firstLen > 1 && isPathSeparator(firstPart.charCodeAt(1))) {
      ++slashCount;
      if (firstLen > 2) {
        if (isPathSeparator(firstPart.charCodeAt(2))) ++slashCount;
        else {
          // We matched a UNC path in the first part
          needsReplace = false;
        }
      }
    }
  }
  if (needsReplace) {
    // Find any more consecutive slashes we need to replace
    while (slashCount < joined.length && isPathSeparator(joined.charCodeAt(slashCount))) {
      slashCount++;
    }

    // Replace the slashes if needed
    if (slashCount >= 2) joined = `\\${joined.slice(slashCount)}`;
  }

  return winNormalize(joined);
}

/**
 * It will solve the relative path from `from` to `to`, for instance
 * from = 'C:\\orandea\\test\\aaa'
 * to = 'C:\\orandea\\impl\\bbb'
 * The output of the function should be: '..\\..\\impl\\bbb'
 * @param {string} from
 * @param {string} to
 * @returns {string}
 */
function winRelative(from, to) {
  validateString(from, 'from');
  validateString(to, 'to');

  if (from === to) return '';

  const fromOrig = winResolve(from);
  const toOrig = winResolve(to);

  if (fromOrig === toOrig) return '';

  from = fromOrig.toLowerCase();
  to = toOrig.toLowerCase();

  if (from === to) return '';

  // Trim any leading backslashes
  let fromStart = 0;
  while (fromStart < from.length && from.charCodeAt(fromStart) === CHAR_BACKWARD_SLASH) {
    fromStart++;
  }
  // Trim trailing backslashes (applicable to UNC paths only)
  let fromEnd = from.length;
  while (fromEnd - 1 > fromStart && from.charCodeAt(fromEnd - 1) === CHAR_BACKWARD_SLASH) {
    fromEnd--;
  }
  const fromLen = fromEnd - fromStart;

  // Trim any leading backslashes
  let toStart = 0;
  while (toStart < to.length && to.charCodeAt(toStart) === CHAR_BACKWARD_SLASH) {
    toStart++;
  }
  // Trim trailing backslashes (applicable to UNC paths only)
  let toEnd = to.length;
  while (toEnd - 1 > toStart && to.charCodeAt(toEnd - 1) === CHAR_BACKWARD_SLASH) {
    toEnd--;
  }
  const toLen = toEnd - toStart;

  // Compare paths to find the longest common path from root
  const length = fromLen < toLen ? fromLen : toLen;
  let lastCommonSep = -1;
  let i = 0;
  for (; i < length; i++) {
    const fromCode = from.charCodeAt(fromStart + i);
    if (fromCode !== to.charCodeAt(toStart + i)) break;
    else if (fromCode === CHAR_BACKWARD_SLASH) lastCommonSep = i;
  }

  // We found a mismatch before the first common path separator was seen, so
  // return the original `to`.
  if (i !== length) {
    if (lastCommonSep === -1) return toOrig;
  } else {
    if (toLen > length) {
      if (to.charCodeAt(toStart + i) === CHAR_BACKWARD_SLASH) {
        // We get here if `from` is the exact base path for `to`.
        // For example: from='C:\\foo\\bar'; to='C:\\foo\\bar\\baz'
        return toOrig.slice(toStart + i + 1);
      }
      if (i === 2) {
        // We get here if `from` is the device root.
        // For example: from='C:\\'; to='C:\\foo'
        return toOrig.slice(toStart + i);
      }
    }
    if (fromLen > length) {
      if (from.charCodeAt(fromStart + i) === CHAR_BACKWARD_SLASH) {
        // We get here if `to` is the exact base path for `from`.
        // For example: from='C:\\foo\\bar'; to='C:\\foo'
        lastCommonSep = i;
      } else if (i === 2) {
        // We get here if `to` is the device root.
        // For example: from='C:\\foo\\bar'; to='C:\\'
        lastCommonSep = 3;
      }
    }
    if (lastCommonSep === -1) lastCommonSep = 0;
  }

  let out = '';
  // Generate the relative path based on the path difference between `to` and
  // `from`
  for (i = fromStart + lastCommonSep + 1; i <= fromEnd; ++i) {
    if (i === fromEnd || from.charCodeAt(i) === CHAR_BACKWARD_SLASH) {
      out += out.length === 0 ? '..' : '\\..';
    }
  }

  toStart += lastCommonSep;

  // Lastly, append the rest of the destination (`to`) path that comes after
  // the common path parts
  if (out.length > 0) return `${out}${toOrig.slice(toStart, toEnd)}`;

  if (toOrig.charCodeAt(toStart) === CHAR_BACKWARD_SLASH) ++toStart;
  return toOrig.slice(toStart, toEnd);
}

/**
 * @param {string} path
 * @returns {string}
 */
function winToNamespacedPath(path) {
  // Note: this will *probably* throw somewhere.
  if (typeof path !== 'string' || path.length === 0) return path;

  const resolvedPath = winResolve(path);

  if (resolvedPath.length <= 2) return path;

  if (resolvedPath.charCodeAt(0) === CHAR_BACKWARD_SLASH) {
    // Possible UNC root
    if (resolvedPath.charCodeAt(1) === CHAR_BACKWARD_SLASH) {
      const code = resolvedPath.charCodeAt(2);
      if (code !== CHAR_QUESTION_MARK && code !== CHAR_DOT) {
        // Matched non-long UNC root, convert the path to a long UNC path
        return `\\\\?\\UNC\\${resolvedPath.slice(2)}`;
      }
    }
  } else if (
    isWindowsDeviceRoot(resolvedPath.charCodeAt(0)) &&
    resolvedPath.charCodeAt(1) === CHAR_COLON &&
    resolvedPath.charCodeAt(2) === CHAR_BACKWARD_SLASH
  ) {
    // Matched device root, convert the path to a long UNC path
    return `\\\\?\\${resolvedPath}`;
  }

  return path;
}

/**
 * @param {string} path
 * @returns {string}
 */
function winDirname(path) {
  validateString(path, 'path');
  const len = path.length;
  if (len === 0) return '.';
  let rootEnd = -1;
  let offset = 0;
  const code = path.charCodeAt(0);

  if (len === 1) {
    // `path` contains just a path separator, exit early to avoid
    // unnecessary work or a dot.
    return isPathSeparator(code) ? path : '.';
  }

  // Try to match a root
  if (isPathSeparator(code)) {
    // Possible UNC root

    rootEnd = offset = 1;

    if (isPathSeparator(path.charCodeAt(1))) {
      // Matched double path separator at beginning
      let j = 2;
      let last = j;
      // Match 1 or more non-path separators
      while (j < len && !isPathSeparator(path.charCodeAt(j))) {
        j++;
      }
      if (j < len && j !== last) {
        // Matched!
        last = j;
        // Match 1 or more path separators
        while (j < len && isPathSeparator(path.charCodeAt(j))) {
          j++;
        }
        if (j < len && j !== last) {
          // Matched!
          last = j;
          // Match 1 or more non-path separators
          while (j < len && !isPathSeparator(path.charCodeAt(j))) {
            j++;
          }
          if (j === len) {
            // We matched a UNC root only
            return path;
          }
          if (j !== last) {
            // We matched a UNC root with leftovers

            // Offset by 1 to include the separator after the UNC root to
            // treat it as a "normal root" on top of a (UNC) root
            rootEnd = offset = j + 1;
          }
        }
      }
    }
    // Possible device root
  } else if (isWindowsDeviceRoot(code) && path.charCodeAt(1) === CHAR_COLON) {
    rootEnd = len > 2 && isPathSeparator(path.charCodeAt(2)) ? 3 : 2;
    offset = rootEnd;
  }

  let end = -1;
  let matchedSlash = true;
  for (let i = len - 1; i >= offset; --i) {
    if (isPathSeparator(path.charCodeAt(i))) {
      if (!matchedSlash) {
        end = i;
        break;
      }
    } else {
      // We saw the first non-path separator
      matchedSlash = false;
    }
  }

  if (end === -1) {
    if (rootEnd === -1) return '.';

    end = rootEnd;
  }
  return path.slice(0, end);
}

/**
 * @param {string} path
 * @param {string} [suffix]
 * @returns {string}
 */
function winBasename(path, suffix) {
  if (suffix !== undefined) validateString(suffix, 'ext');
  validateString(path, 'path');
  let start = 0;
  let end = -1;
  let matchedSlash = true;

  // Check for a drive letter prefix so as not to mistake the following
  // path separator as an extra separator at the end of the path that can be
  // disregarded
  if (
    path.length >= 2 &&
    isWindowsDeviceRoot(path.charCodeAt(0)) &&
    path.charCodeAt(1) === CHAR_COLON
  ) {
    start = 2;
  }

  if (suffix !== undefined && suffix.length > 0 && suffix.length <= path.length) {
    if (suffix === path) return '';
    let extIdx = suffix.length - 1;
    let firstNonSlashEnd = -1;
    for (let i = path.length - 1; i >= start; --i) {
      const code = path.charCodeAt(i);
      if (isPathSeparator(code)) {
        // If we reached a path separator that was not part of a set of path
        // separators at the end of the string, stop now
        if (!matchedSlash) {
          start = i + 1;
          break;
        }
      } else {
        if (firstNonSlashEnd === -1) {
          // We saw the first non-path separator, remember this index in case
          // we need it if the extension ends up not matching
          matchedSlash = false;
          firstNonSlashEnd = i + 1;
        }
        if (extIdx >= 0) {
          // Try to match the explicit extension
          if (code === suffix.charCodeAt(extIdx)) {
            if (--extIdx === -1) {
              // We matched the extension, so mark this as the end of our path
              // component
              end = i;
            }
          } else {
            // Extension does not match, so our result is the entire path
            // component
            extIdx = -1;
            end = firstNonSlashEnd;
          }
        }
      }
    }

    if (start === end) end = firstNonSlashEnd;
    else if (end === -1) end = path.length;
    return path.slice(start, end);
  }
  for (let i = path.length - 1; i >= start; --i) {
    if (isPathSeparator(path.charCodeAt(i))) {
      // If we reached a path separator that was not part of a set of path
      // separators at the end of the string, stop now
      if (!matchedSlash) {
        start = i + 1;
        break;
      }
    } else if (end === -1) {
      // We saw the first non-path separator, mark this as the end of our
      // path component
      matchedSlash = false;
      end = i + 1;
    }
  }

  if (end === -1) return '';
  return path.slice(start, end);
}

/**
 * @param {string} path
 * @returns {string}
 */
function winExtname(path) {
  validateString(path, 'path');
  let start = 0;
  let startDot = -1;
  let startPart = 0;
  let end = -1;
  let matchedSlash = true;
  // Track the state of characters (if any) we see before our first dot and
  // after any path separator we find
  let preDotState = 0;

  // Check for a drive letter prefix so as not to mistake the following
  // path separator as an extra separator at the end of the path that can be
  // disregarded

  if (
    path.length >= 2 &&
    path.charCodeAt(1) === CHAR_COLON &&
    isWindowsDeviceRoot(path.charCodeAt(0))
  ) {
    start = startPart = 2;
  }

  for (let i = path.length - 1; i >= start; --i) {
    const code = path.charCodeAt(i);
    if (isPathSeparator(code)) {
      // If we reached a path separator that was not part of a set of path
      // separators at the end of the string, stop now
      if (!matchedSlash) {
        startPart = i + 1;
        break;
      }
      continue;
    }
    if (end === -1) {
      // We saw the first non-path separator, mark this as the end of our
      // extension
      matchedSlash = false;
      end = i + 1;
    }
    if (code === CHAR_DOT) {
      // If this is our first dot, mark it as the start of our extension
      if (startDot === -1) startDot = i;
      else if (preDotState !== 1) preDotState = 1;
    } else if (startDot !== -1) {
      // We saw a non-dot and non-path separator before our dot, so we should
      // have a good chance at having a non-empty extension
      preDotState = -1;
    }
  }

  if (
    startDot === -1 ||
    end === -1 ||
    // We saw a non-dot character immediately before the dot
    preDotState === 0 ||
    // The (right-most) trimmed path component is exactly '..'
    (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)
  ) {
    return '';
  }
  return path.slice(startDot, end);
}

const winFormat = _format.bind(null, '\\');

/**
 * @param {string} path
 * @returns {{
 *  dir: string;
 *  root: string;
 *  base: string;
 *  name: string;
 *  ext: string;
 *  }}
 */
function winParse(path) {
  validateString(path, 'path');

  const ret = { root: '', dir: '', base: '', ext: '', name: '' };
  if (path.length === 0) return ret;

  const len = path.length;
  let rootEnd = 0;
  let code = path.charCodeAt(0);

  if (len === 1) {
    if (isPathSeparator(code)) {
      // `path` contains just a path separator, exit early to avoid
      // unnecessary work
      ret.root = ret.dir = path;
      return ret;
    }
    ret.base = ret.name = path;
    return ret;
  }
  // Try to match a root
  if (isPathSeparator(code)) {
    // Possible UNC root

    rootEnd = 1;
    if (isPathSeparator(path.charCodeAt(1))) {
      // Matched double path separator at beginning
      let j = 2;
      let last = j;
      // Match 1 or more non-path separators
      while (j < len && !isPathSeparator(path.charCodeAt(j))) {
        j++;
      }
      if (j < len && j !== last) {
        // Matched!
        last = j;
        // Match 1 or more path separators
        while (j < len && isPathSeparator(path.charCodeAt(j))) {
          j++;
        }
        if (j < len && j !== last) {
          // Matched!
          last = j;
          // Match 1 or more non-path separators
          while (j < len && !isPathSeparator(path.charCodeAt(j))) {
            j++;
          }
          if (j === len) {
            // We matched a UNC root only
            rootEnd = j;
          } else if (j !== last) {
            // We matched a UNC root with leftovers
            rootEnd = j + 1;
          }
        }
      }
    }
  } else if (isWindowsDeviceRoot(code) && path.charCodeAt(1) === CHAR_COLON) {
    // Possible device root
    if (len <= 2) {
      // `path` contains just a drive root, exit early to avoid
      // unnecessary work
      ret.root = ret.dir = path;
      return ret;
    }
    rootEnd = 2;
    if (isPathSeparator(path.charCodeAt(2))) {
      if (len === 3) {
        // `path` contains just a drive root, exit early to avoid
        // unnecessary work
        ret.root = ret.dir = path;
        return ret;
      }
      rootEnd = 3;
    }
  }
  if (rootEnd > 0) ret.root = path.slice(0, rootEnd);

  let startDot = -1;
  let startPart = rootEnd;
  let end = -1;
  let matchedSlash = true;
  let i = path.length - 1;

  // Track the state of characters (if any) we see before our first dot and
  // after any path separator we find
  let preDotState = 0;

  // Get non-dir info
  for (; i >= rootEnd; --i) {
    code = path.charCodeAt(i);
    if (isPathSeparator(code)) {
      // If we reached a path separator that was not part of a set of path
      // separators at the end of the string, stop now
      if (!matchedSlash) {
        startPart = i + 1;
        break;
      }
      continue;
    }
    if (end === -1) {
      // We saw the first non-path separator, mark this as the end of our
      // extension
      matchedSlash = false;
      end = i + 1;
    }
    if (code === CHAR_DOT) {
      // If this is our first dot, mark it as the start of our extension
      if (startDot === -1) startDot = i;
      else if (preDotState !== 1) preDotState = 1;
    } else if (startDot !== -1) {
      // We saw a non-dot and non-path separator before our dot, so we should
      // have a good chance at having a non-empty extension
      preDotState = -1;
    }
  }

  if (end !== -1) {
    if (
      startDot === -1 ||
      // We saw a non-dot character immediately before the dot
      preDotState === 0 ||
      // The (right-most) trimmed path component is exactly '..'
      (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)
    ) {
      ret.base = ret.name = path.slice(startPart, end);
    } else {
      ret.name = path.slice(startPart, startDot);
      ret.base = path.slice(startPart, end);
      ret.ext = path.slice(startDot, end);
    }
  }

  // If the directory is the root, use the entire root as the `dir` including
  // the trailing slash if any (`C:\abc` -> `C:\`). Otherwise, strip out the
  // trailing slash (`C:\abc\def` -> `C:\abc`).
  if (startPart > 0 && startPart !== rootEnd) ret.dir = path.slice(0, startPart - 1);
  else ret.dir = ret.root;

  return ret;
}

const winSep = '\\';
const winDelimiter = ';';

const posixCwd = (() => {
  if (platformIsWin32) {
    // Converts Windows' backslash path separators to POSIX forward slashes
    // and truncates any drive indicator
    const regexp = /\\/g;
    return () => {
      const cwd = process.cwd().replace(regexp, '/');
      return cwd.slice(cwd.indexOf('/'));
    };
  }

  // We're already on POSIX, no need for any transformations
  return () => process.cwd();
})();

/**
 * path.resolve([from ...], to)
 * @param {...string} args
 * @returns {string}
 */
function posResolve(...args) {
  let resolvedPath = '';
  let resolvedAbsolute = false;

  for (let i = args.length - 1; i >= -1 && !resolvedAbsolute; i--) {
    const path = i >= 0 ? args[i] : posixCwd();
    validateString(path, `paths[${i}]`);

    // Skip empty entries
    if (path.length === 0) {
      continue;
    }

    resolvedPath = `${path}/${resolvedPath}`;
    resolvedAbsolute = path.charCodeAt(0) === CHAR_FORWARD_SLASH;
  }

  // At this point the path should be resolved to a full absolute path, but
  // handle relative paths to be safe (might happen when process.cwd() fails)

  // Normalize the path
  resolvedPath = normalizeString(resolvedPath, !resolvedAbsolute, '/', isPosixPathSeparator);

  if (resolvedAbsolute) {
    return `/${resolvedPath}`;
  }
  return resolvedPath.length > 0 ? resolvedPath : '.';
}

/**
 * @param {string} path
 * @returns {string}
 */
function posNormalize(path) {
  validateString(path, 'path');

  if (path.length === 0) return '.';

  const isAbsolute = path.charCodeAt(0) === CHAR_FORWARD_SLASH;
  const trailingSeparator = path.charCodeAt(path.length - 1) === CHAR_FORWARD_SLASH;

  // Normalize the path
  path = normalizeString(path, !isAbsolute, '/', isPosixPathSeparator);

  if (path.length === 0) {
    if (isAbsolute) return '/';
    return trailingSeparator ? './' : '.';
  }
  if (trailingSeparator) path += '/';

  return isAbsolute ? `/${path}` : path;
}

/**
 * @param {string} path
 * @returns {boolean}
 */
function posIsAbsolute(path) {
  validateString(path, 'path');
  return path.length > 0 && path.charCodeAt(0) === CHAR_FORWARD_SLASH;
}

/**
 * @param {...string} args
 * @returns {string}
 */
function posJoin(...args) {
  if (args.length === 0) return '.';
  let joined;
  for (let i = 0; i < args.length; ++i) {
    const arg = args[i];
    validateString(arg, 'path');
    if (arg.length > 0) {
      if (joined === undefined) joined = arg;
      else joined += `/${arg}`;
    }
  }
  if (joined === undefined) return '.';
  return posNormalize(joined);
}

/**
 * @param {string} from
 * @param {string} to
 * @returns {string}
 */
function posRelative(from, to) {
  validateString(from, 'from');
  validateString(to, 'to');

  if (from === to) return '';

  // Trim leading forward slashes.
  from = posResolve(from);
  to = posResolve(to);

  if (from === to) return '';

  const fromStart = 1;
  const fromEnd = from.length;
  const fromLen = fromEnd - fromStart;
  const toStart = 1;
  const toLen = to.length - toStart;

  // Compare paths to find the longest common path from root
  const length = fromLen < toLen ? fromLen : toLen;
  let lastCommonSep = -1;
  let i = 0;
  for (; i < length; i++) {
    const fromCode = from.charCodeAt(fromStart + i);
    if (fromCode !== to.charCodeAt(toStart + i)) break;
    else if (fromCode === CHAR_FORWARD_SLASH) lastCommonSep = i;
  }
  if (i === length) {
    if (toLen > length) {
      if (to.charCodeAt(toStart + i) === CHAR_FORWARD_SLASH) {
        // We get here if `from` is the exact base path for `to`.
        // For example: from='/foo/bar'; to='/foo/bar/baz'
        return to.slice(toStart + i + 1);
      }
      if (i === 0) {
        // We get here if `from` is the root
        // For example: from='/'; to='/foo'
        return to.slice(toStart + i);
      }
    } else if (fromLen > length) {
      if (from.charCodeAt(fromStart + i) === CHAR_FORWARD_SLASH) {
        // We get here if `to` is the exact base path for `from`.
        // For example: from='/foo/bar/baz'; to='/foo/bar'
        lastCommonSep = i;
      } else if (i === 0) {
        // We get here if `to` is the root.
        // For example: from='/foo/bar'; to='/'
        lastCommonSep = 0;
      }
    }
  }

  let out = '';
  // Generate the relative path based on the path difference between `to`
  // and `from`.
  for (i = fromStart + lastCommonSep + 1; i <= fromEnd; ++i) {
    if (i === fromEnd || from.charCodeAt(i) === CHAR_FORWARD_SLASH) {
      out += out.length === 0 ? '..' : '/..';
    }
  }

  // Lastly, append the rest of the destination (`to`) path that comes after
  // the common path parts.
  return `${out}${to.slice(toStart + lastCommonSep)}`;
}

/**
 * @param {string} path
 * @returns {string}
 */
function posToNamespacedPath(path) {
  // Non-op on posix systems
  return path;
}

/**
 * @param {string} path
 * @returns {string}
 */
function posDirname(path) {
  validateString(path, 'path');
  if (path.length === 0) return '.';
  const hasRoot = path.charCodeAt(0) === CHAR_FORWARD_SLASH;
  let end = -1;
  let matchedSlash = true;
  for (let i = path.length - 1; i >= 1; --i) {
    if (path.charCodeAt(i) === CHAR_FORWARD_SLASH) {
      if (!matchedSlash) {
        end = i;
        break;
      }
    } else {
      // We saw the first non-path separator
      matchedSlash = false;
    }
  }

  if (end === -1) return hasRoot ? '/' : '.';
  if (hasRoot && end === 1) return '//';
  return path.slice(0, end);
}

/**
 * @param {string} path
 * @param {string} [suffix]
 * @returns {string}
 */
function posBasename(path, suffix) {
  if (suffix !== undefined) validateString(suffix, 'ext');
  validateString(path, 'path');

  let start = 0;
  let end = -1;
  let matchedSlash = true;

  if (suffix !== undefined && suffix.length > 0 && suffix.length <= path.length) {
    if (suffix === path) return '';
    let extIdx = suffix.length - 1;
    let firstNonSlashEnd = -1;
    for (let i = path.length - 1; i >= 0; --i) {
      const code = path.charCodeAt(i);
      if (code === CHAR_FORWARD_SLASH) {
        // If we reached a path separator that was not part of a set of path
        // separators at the end of the string, stop now
        if (!matchedSlash) {
          start = i + 1;
          break;
        }
      } else {
        if (firstNonSlashEnd === -1) {
          // We saw the first non-path separator, remember this index in case
          // we need it if the extension ends up not matching
          matchedSlash = false;
          firstNonSlashEnd = i + 1;
        }
        if (extIdx >= 0) {
          // Try to match the explicit extension
          if (code === suffix.charCodeAt(extIdx)) {
            if (--extIdx === -1) {
              // We matched the extension, so mark this as the end of our path
              // component
              end = i;
            }
          } else {
            // Extension does not match, so our result is the entire path
            // component
            extIdx = -1;
            end = firstNonSlashEnd;
          }
        }
      }
    }

    if (start === end) end = firstNonSlashEnd;
    else if (end === -1) end = path.length;
    return path.slice(start, end);
  }
  for (let i = path.length - 1; i >= 0; --i) {
    if (path.charCodeAt(i) === CHAR_FORWARD_SLASH) {
      // If we reached a path separator that was not part of a set of path
      // separators at the end of the string, stop now
      if (!matchedSlash) {
        start = i + 1;
        break;
      }
    } else if (end === -1) {
      // We saw the first non-path separator, mark this as the end of our
      // path component
      matchedSlash = false;
      end = i + 1;
    }
  }

  if (end === -1) return '';
  return path.slice(start, end);
}

/**
 * @param {string} path
 * @returns {string}
 */
function posExtname(path) {
  validateString(path, 'path');
  let startDot = -1;
  let startPart = 0;
  let end = -1;
  let matchedSlash = true;
  // Track the state of characters (if any) we see before our first dot and
  // after any path separator we find
  let preDotState = 0;
  for (let i = path.length - 1; i >= 0; --i) {
    const code = path.charCodeAt(i);
    if (code === CHAR_FORWARD_SLASH) {
      // If we reached a path separator that was not part of a set of path
      // separators at the end of the string, stop now
      if (!matchedSlash) {
        startPart = i + 1;
        break;
      }
      continue;
    }
    if (end === -1) {
      // We saw the first non-path separator, mark this as the end of our
      // extension
      matchedSlash = false;
      end = i + 1;
    }
    if (code === CHAR_DOT) {
      // If this is our first dot, mark it as the start of our extension
      if (startDot === -1) startDot = i;
      else if (preDotState !== 1) preDotState = 1;
    } else if (startDot !== -1) {
      // We saw a non-dot and non-path separator before our dot, so we should
      // have a good chance at having a non-empty extension
      preDotState = -1;
    }
  }

  if (
    startDot === -1 ||
    end === -1 ||
    // We saw a non-dot character immediately before the dot
    preDotState === 0 ||
    // The (right-most) trimmed path component is exactly '..'
    (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)
  ) {
    return '';
  }
  return path.slice(startDot, end);
}

const posFormat = _format.bind(null, '/');

/**
 * @param {string} path
 * @returns {{
 *   dir: string;
 *   root: string;
 *   base: string;
 *   name: string;
 *   ext: string;
 *   }}
 */
function posParse(path) {
  validateString(path, 'path');

  const ret = { root: '', dir: '', base: '', ext: '', name: '' };
  if (path.length === 0) return ret;
  const isAbsolute = path.charCodeAt(0) === CHAR_FORWARD_SLASH;
  let start;
  if (isAbsolute) {
    ret.root = '/';
    start = 1;
  } else {
    start = 0;
  }
  let startDot = -1;
  let startPart = 0;
  let end = -1;
  let matchedSlash = true;
  let i = path.length - 1;

  // Track the state of characters (if any) we see before our first dot and
  // after any path separator we find
  let preDotState = 0;

  // Get non-dir info
  for (; i >= start; --i) {
    const code = path.charCodeAt(i);
    if (code === CHAR_FORWARD_SLASH) {
      // If we reached a path separator that was not part of a set of path
      // separators at the end of the string, stop now
      if (!matchedSlash) {
        startPart = i + 1;
        break;
      }
      continue;
    }
    if (end === -1) {
      // We saw the first non-path separator, mark this as the end of our
      // extension
      matchedSlash = false;
      end = i + 1;
    }
    if (code === CHAR_DOT) {
      // If this is our first dot, mark it as the start of our extension
      if (startDot === -1) startDot = i;
      else if (preDotState !== 1) preDotState = 1;
    } else if (startDot !== -1) {
      // We saw a non-dot and non-path separator before our dot, so we should
      // have a good chance at having a non-empty extension
      preDotState = -1;
    }
  }

  if (end !== -1) {
    const start = startPart === 0 && isAbsolute ? 1 : startPart;
    if (
      startDot === -1 ||
      // We saw a non-dot character immediately before the dot
      preDotState === 0 ||
      // The (right-most) trimmed path component is exactly '..'
      (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)
    ) {
      ret.base = ret.name = path.slice(start, end);
    } else {
      ret.name = path.slice(start, startDot);
      ret.base = path.slice(start, end);
      ret.ext = path.slice(startDot, end);
    }
  }

  if (startPart > 0) ret.dir = path.slice(0, startPart - 1);
  else if (isAbsolute) ret.dir = '/';

  return ret;
}

const posSep = '/';
const posDelimiter = ':';

// _posix.win32 = _win32.win32 = _win32;
// _posix.posix = _win32.posix = _posix;

// // Legacy internal API, docs-only deprecated: DEP0080
// _win32._makeLong = _win32.toNamespacedPath;
// _posix._makeLong = _posix.toNamespacedPath;

const __win32 = {
  resolve: winResolve,
  normalize: winNormalize,
  isAbsolute: winIsAbsolute,
  join: winJoin,
  relative: winRelative,
  toNamespacedPath: winToNamespacedPath,
  dirname: winDirname,
  basename: winBasename,
  extname: winExtname,
  format: winFormat,
  parse: winParse,
  sep: winSep,
  delimiter: winDelimiter,
};

const __posix = {
  resolve: posResolve,
  normalize: posNormalize,
  isAbsolute: posIsAbsolute,
  join: posJoin,
  relative: posRelative,
  toNamespacedPath: posToNamespacedPath,
  dirname: posDirname,
  basename: posBasename,
  extname: posExtname,
  format: posFormat,
  parse: posParse,
  sep: posSep,
  delimiter: posDelimiter,
};

// import { win32 } from 'path-unified' -> bad for treeshaking
export const win32 = {
  ...__win32,
  posix: __posix, // this makes it bad for treeshaking too since otherwise we'd only need to load posix stuff... but keeping it to support current path API
  win32: __win32,
};

// import { posix } from 'path-unified' -> bad for treeshaking
export const posix = {
  ...__posix,
  posix: __posix,
  win32: __win32, // this makes it bad for treeshaking too since otherwise we'd only need to load posix stuff... but keeping it to support current path API
};

// import path from 'path-unified' -> bad for treeshaking
export default platformIsWin32 ? win32 : posix;

// import { resolve } from 'path-unified' -> ideal for treeshaking
export const resolve = platformIsWin32 ? winResolve : posResolve;
export const normalize = platformIsWin32 ? winNormalize : posNormalize;
export const isAbsolute = platformIsWin32 ? winIsAbsolute : posIsAbsolute;
export const join = platformIsWin32 ? winJoin : posJoin;
export const relative = platformIsWin32 ? winRelative : posRelative;
export const toNamespacedPath = platformIsWin32 ? winToNamespacedPath : posToNamespacedPath;
export const dirname = platformIsWin32 ? winDirname : posDirname;
export const basename = platformIsWin32 ? winBasename : posBasename;
export const extname = platformIsWin32 ? winExtname : posExtname;
export const format = platformIsWin32 ? winFormat : posFormat;
export const parse = platformIsWin32 ? winParse : posParse;
export const sep = platformIsWin32 ? winSep : posSep;
export const delimiter = platformIsWin32 ? winDelimiter : posDelimiter;
