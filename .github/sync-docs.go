package main

import (
	"encoding/json"
	"fmt"
	"io/ioutil"
	"os"
	"path/filepath"
	"strings"
)

func main() {
	docsFolder := "ccp/business/aws/templates/iam"
	fileMap := make(map[string]interface{})

	err := filepath.Walk(docsFolder, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}

		if !info.IsDir() && filepath.Ext(path) == ".json" {
			fileContents, err := ioutil.ReadFile(path)
			if err != nil {
				return err
			}

			var jsonData interface{}
			err = json.Unmarshal(fileContents, &jsonData)
			if err != nil {
				return err
			}

			fileName := filepath.Base(path)
			fileName = strings.ReplaceAll(fileName, ".", "_")
			fileMap[fileName] = jsonData
		}

		return nil
	})
	if err != nil {
		fmt.Println("Error reading files:", err)
		return
	}

	// Print the file map
	jsonData, err := json.MarshalIndent(fileMap, "", "  ")
	if err != nil {
		fmt.Println("Error creating json:", err)
		return
	}
	fmt.Println("export const awsPermissions =", string(jsonData))
}
