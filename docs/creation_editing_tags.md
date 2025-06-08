# Creation Editing Tags

This document explains how the chat model can update existing creations directly during a conversation.

## Overview

Creations are special blocks of content (code, diagrams, markdown…) that are stored in the gallery. Previously the model could only create new blocks. With editing tags the model can modify a prior creation by referencing its **title**.

## Tags

- `$$appendcreation:Title$$ ... $$end$$` – append the given content to the creation with matching title.
- `$$editcreation:Title$$ ... $$end$$` – replace the entire content of the creation with the provided text.
- `$$replacecreation:Title$$` followed by the section to find, `$$with$$`, then the replacement and finally `$$end$$` – replace only a specific part of the creation.

Example:

```
$$replacecreation:Data Chart$$
const data = [1,2,3];
$$with$$
const data = [4,5,6];
$$end$$
```

The app looks up the creation titled *Data Chart*, finds the first occurrence of the target snippet and replaces it with the new snippet.

## Flow

1. The assistant emits one or more of the editing tags while streaming a message.
2. The frontend detects these tags using `detectCreationEdits`.
3. For each directive the corresponding update is applied via `creationManager`.
4. The gallery and viewer update immediately to reflect the change.

