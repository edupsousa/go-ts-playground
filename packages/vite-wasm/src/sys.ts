class ErrorWithCode extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

const decoder = new TextDecoder("utf-8");
let outputBuf = "";

const enosys = () => {
  const err = new ErrorWithCode("not implemented", "ENOSYS");
  return err;
};

export const fs = {
  constants: {
    O_WRONLY: -1,
    O_RDWR: -1,
    O_CREAT: -1,
    O_TRUNC: -1,
    O_APPEND: -1,
    O_EXCL: -1,
  }, // unused
  writeSync(fd: unknown, buf: Uint8Array) {
    outputBuf += decoder.decode(buf);
    const nl = outputBuf.lastIndexOf("\n");
    if (nl != -1) {
      console.log(outputBuf.substr(0, nl));
      outputBuf = outputBuf.substr(nl + 1);
    }
    return buf.length;
  },
  write(
    fd: unknown,
    buf: Uint8Array,
    offset: unknown,
    length: unknown,
    position: unknown,
    callback: Function
  ) {
    if (offset !== 0 || length !== buf.length || position !== null) {
      callback(enosys());
      return;
    }
    const n = this.writeSync(fd, buf);
    callback(null, n);
  },
  chmod(path: unknown, mode: unknown, callback: Function) {
    callback(enosys());
  },
  chown(path: unknown, uid: unknown, gid: unknown, callback: Function) {
    callback(enosys());
  },
  close(fd: unknown, callback: Function) {
    callback(enosys());
  },
  fchmod(fd: unknown, mode: unknown, callback: Function) {
    callback(enosys());
  },
  fchown(fd: unknown, uid: unknown, gid: unknown, callback: Function) {
    callback(enosys());
  },
  fstat(fd: unknown, callback: Function) {
    callback(enosys());
  },
  fsync(fd: unknown, callback: Function) {
    callback(null);
  },
  ftruncate(fd: unknown, length: unknown, callback: Function) {
    callback(enosys());
  },
  lchown(path: unknown, uid: unknown, gid: unknown, callback: Function) {
    callback(enosys());
  },
  link(path: unknown, link: unknown, callback: Function) {
    callback(enosys());
  },
  lstat(path: unknown, callback: Function) {
    callback(enosys());
  },
  mkdir(path: unknown, perm: unknown, callback: Function) {
    callback(enosys());
  },
  open(path: unknown, flags: unknown, mode: unknown, callback: Function) {
    callback(enosys());
  },
  read(
    fd: unknown,
    buffer: unknown,
    offset: unknown,
    length: unknown,
    position: unknown,
    callback: Function
  ) {
    callback(enosys());
  },
  readdir(path: unknown, callback: Function) {
    callback(enosys());
  },
  readlink(path: unknown, callback: Function) {
    callback(enosys());
  },
  rename(from: unknown, to: unknown, callback: Function) {
    callback(enosys());
  },
  rmdir(path: unknown, callback: Function) {
    callback(enosys());
  },
  stat(path: unknown, callback: Function) {
    callback(enosys());
  },
  symlink(path: unknown, link: unknown, callback: Function) {
    callback(enosys());
  },
  truncate(path: unknown, length: unknown, callback: Function) {
    callback(enosys());
  },
  unlink(path: unknown, callback: Function) {
    callback(enosys());
  },
  utimes(path: unknown, atime: unknown, mtime: unknown, callback: Function) {
    callback(enosys());
  },
};

export const process = {
  getuid() {
    return -1;
  },
  getgid() {
    return -1;
  },
  geteuid() {
    return -1;
  },
  getegid() {
    return -1;
  },
  getgroups() {
    throw enosys();
  },
  pid: -1,
  ppid: -1,
  umask() {
    throw enosys();
  },
  cwd() {
    throw enosys();
  },
  chdir() {
    throw enosys();
  },
};
