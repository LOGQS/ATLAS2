# status: complete
"""
Centralized file extension definitions.

Single source of truth for file type categorization across the codebase.
All extension sets use lowercase with leading dot (e.g., '.py').
"""

# ============================================================
# ATOMIC CATEGORIES - Single source of truth for each file type
# ============================================================

# Media - Visual (raster and vector images)
IMAGE_EXTENSIONS = {
    '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp',
    '.tiff', '.tif', '.ico', '.heic', '.heif', '.avif',
    '.svg',  # Vector (XML-based but treated as image)
    '.raw', '.cr2', '.nef', '.dng',  # RAW formats
}

# Media - Audio
AUDIO_EXTENSIONS = {
    '.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a',
    '.wma', '.opus', '.aiff', '.alac', '.ape', '.mid', '.midi',
}

# Media - Video
VIDEO_EXTENSIONS = {
    '.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm',
    '.mkv', '.m4v', '.mpg', '.mpeg', '.3gp', '.ts', '.mts',
}

# Documents (binary/complex formats)
DOCUMENT_EXTENSIONS = {
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
    '.odt', '.ods', '.odp', '.rtf', '.epub', '.mobi',
    '.pages', '.numbers', '.key',  # Apple iWork
}

# Programming Languages
CODE_EXTENSIONS = {
    # Popular
    '.py', '.pyw', '.pyi',  # Python
    '.js', '.mjs', '.cjs',  # JavaScript
    '.ts', '.mts', '.cts',  # TypeScript
    '.jsx', '.tsx',  # React
    '.java', '.kt', '.kts',  # JVM
    '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hxx',  # C/C++
    '.cs',  # C#
    '.go',  # Go
    '.rs',  # Rust
    '.rb', '.rake',  # Ruby
    '.php',  # PHP
    '.swift',  # Swift
    '.scala', '.sc',  # Scala
    '.vb', '.vbs',  # Visual Basic
    # Other languages
    '.lua',
    '.r', '.R',  # R
    '.jl',  # Julia
    '.pl', '.pm',  # Perl
    '.ex', '.exs',  # Elixir
    '.clj', '.cljs', '.cljc', '.edn',  # Clojure
    '.dart',
    '.elm',
    '.erl', '.hrl',  # Erlang
    '.fs', '.fsx', '.fsi',  # F#
    '.hs', '.lhs',  # Haskell
    '.ml', '.mli',  # OCaml
    '.nim', '.nims',  # Nim
    '.v',  # V / Verilog
    '.zig',
    '.m', '.mm',  # Objective-C
    '.f', '.f90', '.f95', '.f03', '.for',  # Fortran
    '.asm', '.s',  # Assembly
    '.groovy', '.gradle',
    '.vue', '.svelte',  # Framework components
    '.sol',  # Solidity
    '.mo',  # Motoko
    '.rkt',  # Racket
    '.lisp', '.cl', '.el',  # Lisp variants
    '.tcl',
    '.pas', '.pp',  # Pascal
    '.d',  # D
    '.cr',  # Crystal
    '.purs',  # PureScript
    '.re', '.rei',  # ReasonML
    '.cob', '.cbl',  # COBOL
}

# Plain Text / Markup
TEXT_EXTENSIONS = {
    '.txt', '.md', '.markdown', '.rst', '.log',
    '.tex', '.latex', '.org', '.adoc', '.asciidoc',
    '.nfo', '.diz',
}

# Configuration
CONFIG_EXTENSIONS = {
    '.json', '.jsonc', '.json5',
    '.yaml', '.yml',
    '.toml',
    '.ini', '.cfg', '.conf',
    '.env', '.envrc',
    '.properties',
    '.editorconfig', '.prettierrc', '.eslintrc',
    '.babelrc', '.npmrc', '.yarnrc',
}

# Data / Query / Schema
DATA_EXTENSIONS = {
    '.csv', '.tsv',
    '.sql',
    '.graphql', '.gql',
    '.proto',  # Protocol Buffers
    '.thrift',
    '.avro',
    '.parquet',
}

# Web
WEB_EXTENSIONS = {
    '.html', '.htm', '.xhtml',
    '.css', '.scss', '.sass', '.less', '.styl',
    '.xml', '.xsl', '.xslt', '.xsd', '.dtd',
    '.rss', '.atom',
    '.wsdl', '.soap',
}

# Notebooks
NOTEBOOK_EXTENSIONS = {
    '.ipynb',  # Jupyter
    '.rmd',  # R Markdown
    '.qmd',  # Quarto
}

# Shell Scripts
SCRIPT_EXTENSIONS = {
    '.sh', '.bash', '.zsh', '.fish',
    '.ps1', '.psm1', '.psd1',  # PowerShell
    '.bat', '.cmd',  # Windows batch
    '.awk', '.sed',
}

# Archives
ARCHIVE_EXTENSIONS = {
    '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar',
    '.iso', '.dmg', '.img',
    '.cab', '.arj', '.lzh', '.lz', '.lz4', '.zst',
}

# Executables / Libraries
EXECUTABLE_EXTENSIONS = {
    '.exe', '.dll', '.sys',  # Windows
    '.so', '.a',  # Linux
    '.dylib', '.bundle',  # macOS
    '.bin', '.app',
    '.msi', '.deb', '.rpm', '.pkg', '.apk', '.ipa',
    '.com', '.scr',
}

# Databases
DATABASE_EXTENSIONS = {
    '.db', '.sqlite', '.sqlite3', '.mdb', '.accdb',
    '.dbf', '.sdf',
}

# Compiled / Bytecode
COMPILED_EXTENSIONS = {
    '.pyc', '.pyo', '.pyd',  # Python
    '.class',  # Java
    '.jar', '.war', '.ear',  # Java archives
    '.o', '.obj', '.a', '.lib',  # Native
    '.wasm', '.wat',  # WebAssembly
    '.beam',  # Erlang/Elixir
    '.luac',  # Lua
    '.elc',  # Emacs Lisp
}

# Fonts
FONT_EXTENSIONS = {
    '.ttf', '.otf', '.woff', '.woff2', '.eot', '.fon', '.fnt',
}

# 3D / CAD / Design
DESIGN_EXTENSIONS = {
    '.obj', '.stl', '.fbx', '.gltf', '.glb',
    '.blend', '.max', '.maya',
    '.psd', '.ai', '.sketch', '.fig', '.xd',
    '.dwg', '.dxf',
}


# ============================================================
# DERIVED COMPOSITES
# ============================================================

# All textual files (can be safely read/edited as text)
TEXTUAL_EXTENSIONS = (
    CODE_EXTENSIONS |
    TEXT_EXTENSIONS |
    CONFIG_EXTENSIONS |
    DATA_EXTENSIONS |
    WEB_EXTENSIONS |
    SCRIPT_EXTENSIONS |
    NOTEBOOK_EXTENSIONS  # JSON-based, technically text
)

# All binary files (should not be read as text)
BINARY_EXTENSIONS = (
    IMAGE_EXTENSIONS |
    AUDIO_EXTENSIONS |
    VIDEO_EXTENSIONS |
    DOCUMENT_EXTENSIONS |
    ARCHIVE_EXTENSIONS |
    EXECUTABLE_EXTENSIONS |
    DATABASE_EXTENSIONS |
    COMPILED_EXTENSIONS |
    FONT_EXTENSIONS |
    DESIGN_EXTENSIONS
)


# ============================================================
# CONVERSION TARGETS (for file_converter.py)
# Files needing conversion to standard formats
# ============================================================

# Images to convert to PNG (excludes PNG and SVG which need special handling)
IMAGE_CONVERTIBLE = IMAGE_EXTENSIONS - {'.png', '.svg'}

# Audio to convert to MP3
AUDIO_CONVERTIBLE = AUDIO_EXTENSIONS - {'.mp3'}

# Video to convert to MP4
VIDEO_CONVERTIBLE = VIDEO_EXTENSIONS - {'.mp4'}
