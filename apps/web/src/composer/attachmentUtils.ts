export function hasFiles(dataTransfer: DataTransfer) {
  return filesFromDataTransfer(dataTransfer).length > 0;
}

export function filesFromDataTransfer(dataTransfer: DataTransfer): File[] {
  const items = Array.from(dataTransfer.items);
  if (items.length > 0) {
    const itemFiles = items
      .filter((item) => item.kind === "file")
      .map((item) => (typeof item.getAsFile === "function" ? item.getAsFile() : null))
      .filter((file): file is File => file !== null);
    if (itemFiles.length > 0) {
      return itemFiles;
    }
  }
  return Array.from(dataTransfer.files);
}

export function createObjectUrl(file: File) {
  return typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : "";
}

export function revokeObjectUrl(objectUrl: string) {
  if (objectUrl && typeof URL.revokeObjectURL === "function") {
    URL.revokeObjectURL(objectUrl);
  }
}
