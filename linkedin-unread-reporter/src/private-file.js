function isPrivateRegularFile(stat) {
  return stat?.isFile?.() === true && (stat.mode & 0o7777) === 0o600;
}

function isSameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function secureReadError(message) {
  return new Error(message);
}

export function readPrivateFileSync({ filePath, fileSystem, errorMessage }) {
  const noFollowFlag = fileSystem.constants?.O_NOFOLLOW;
  if (!Number.isInteger(noFollowFlag) || noFollowFlag <= 0) {
    throw secureReadError(errorMessage);
  }

  let descriptor;
  try {
    descriptor = fileSystem.openSync(
      filePath,
      (fileSystem.constants?.O_RDONLY ?? 0) | noFollowFlag,
    );
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw secureReadError(errorMessage);
  }

  let contents;
  let primaryError;
  try {
    const openedStat = fileSystem.fstatSync(descriptor);
    if (!isPrivateRegularFile(openedStat)) throw secureReadError(errorMessage);
    contents = fileSystem.readFileSync(descriptor, 'utf8');
    const pathStat = fileSystem.lstatSync(filePath);
    if (!isPrivateRegularFile(pathStat) || !isSameFile(openedStat, pathStat)) {
      throw secureReadError(errorMessage);
    }
  } catch {
    primaryError = secureReadError(errorMessage);
  }

  try {
    fileSystem.closeSync(descriptor);
  } catch {
    if (!primaryError) primaryError = secureReadError(errorMessage);
  }
  if (primaryError) throw primaryError;
  return contents;
}

export async function readPrivateFile({ filePath, fileSystem, errorMessage }) {
  const noFollowFlag = fileSystem.constants?.O_NOFOLLOW;
  if (!Number.isInteger(noFollowFlag) || noFollowFlag <= 0) {
    throw secureReadError(errorMessage);
  }

  let handle;
  try {
    handle = await fileSystem.open(
      filePath,
      (fileSystem.constants?.O_RDONLY ?? 0) | noFollowFlag,
    );
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw secureReadError(errorMessage);
  }

  let contents;
  let primaryError;
  try {
    const openedStat = await handle.stat();
    if (!isPrivateRegularFile(openedStat)) throw secureReadError(errorMessage);
    contents = await handle.readFile('utf8');
    const pathStat = await fileSystem.lstat(filePath);
    if (!isPrivateRegularFile(pathStat) || !isSameFile(openedStat, pathStat)) {
      throw secureReadError(errorMessage);
    }
  } catch {
    primaryError = secureReadError(errorMessage);
  }

  try {
    await handle.close();
  } catch {
    if (!primaryError) primaryError = secureReadError(errorMessage);
  }
  if (primaryError) throw primaryError;
  return contents;
}
