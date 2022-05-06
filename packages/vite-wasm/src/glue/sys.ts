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
  writeSync(_fd: unknown, buf: Uint8Array) {
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
  chmod(_path: unknown, _mode: unknown, callback: Function) {
    callback(enosys());
  },
  chown(_path: unknown, _uid: unknown, _gid: unknown, callback: Function) {
    callback(enosys());
  },
  close(_fd: unknown, callback: Function) {
    callback(enosys());
  },
  fchmod(_fd: unknown, _mode: unknown, callback: Function) {
    callback(enosys());
  },
  fchown(_fd: unknown, _uid: unknown, _gid: unknown, callback: Function) {
    callback(enosys());
  },
  fstat(_fd: unknown, callback: Function) {
    callback(enosys());
  },
  fsync(_fd: unknown, callback: Function) {
    callback(null);
  },
  ftruncate(_fd: unknown, _length: unknown, callback: Function) {
    callback(enosys());
  },
  lchown(_path: unknown, _uid: unknown, _gid: unknown, callback: Function) {
    callback(enosys());
  },
  link(_path: unknown, _link: unknown, callback: Function) {
    callback(enosys());
  },
  lstat(_path: unknown, callback: Function) {
    callback(enosys());
  },
  mkdir(_path: unknown, _perm: unknown, callback: Function) {
    callback(enosys());
  },
  open(_path: unknown, _flags: unknown, _mode: unknown, callback: Function) {
    callback(enosys());
  },
  read(
    _fd: unknown,
    _buffer: unknown,
    _offset: unknown,
    _length: unknown,
    _position: unknown,
    callback: Function
  ) {
    callback(enosys());
  },
  readdir(_path: unknown, callback: Function) {
    callback(enosys());
  },
  readlink(_path: unknown, callback: Function) {
    callback(enosys());
  },
  rename(_from: unknown, _to: unknown, callback: Function) {
    callback(enosys());
  },
  rmdir(_path: unknown, callback: Function) {
    callback(enosys());
  },
  stat(_path: unknown, callback: Function) {
    callback(enosys());
  },
  symlink(_path: unknown, _link: unknown, callback: Function) {
    callback(enosys());
  },
  truncate(_path: unknown, _length: unknown, callback: Function) {
    callback(enosys());
  },
  unlink(_path: unknown, callback: Function) {
    callback(enosys());
  },
  utimes(_path: unknown, _atime: unknown, _mtime: unknown, callback: Function) {
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
